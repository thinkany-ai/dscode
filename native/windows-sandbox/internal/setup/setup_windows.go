//go:build windows

package setup

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/filesystem"
	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/firewall"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	DefaultPrefix = "DSCode"
	stateVersion  = 3

	userPrivUser          = 1
	ufScript              = 0x0001
	ufPasswordCantChange  = 0x0040
	ufNormalAccount       = 0x0200
	ufPasswordNeverExpire = 0x10000

	nerrUserNotFound = 2221
	nerrUserExists   = 2224

	policyCreateAccount = 0x0010
	policyLookupNames   = 0x0800
)

var (
	netapi32                      = windows.NewLazySystemDLL("netapi32.dll")
	procNetUserAdd                = netapi32.NewProc("NetUserAdd")
	procNetUserDel                = netapi32.NewProc("NetUserDel")
	procNetUserGetInfo            = netapi32.NewProc("NetUserGetInfo")
	procNetApiBufferFree          = netapi32.NewProc("NetApiBufferFree")
	advapi32                      = windows.NewLazySystemDLL("advapi32.dll")
	procLsaOpenPolicy             = advapi32.NewProc("LsaOpenPolicy")
	procLsaAddAccountRights       = advapi32.NewProc("LsaAddAccountRights")
	procLsaRemoveAccountRights    = advapi32.NewProc("LsaRemoveAccountRights")
	procLsaEnumerateAccountRights = advapi32.NewProc("LsaEnumerateAccountRights")
	procLsaFreeMemory             = advapi32.NewProc("LsaFreeMemory")
	procLsaClose                  = advapi32.NewProc("LsaClose")
	procLsaNtStatusToWinError     = advapi32.NewProc("LsaNtStatusToWinError")
	procLogonUser                 = advapi32.NewProc("LogonUserW")
)

var deniedLogonRights = []string{
	"SeDenyInteractiveLogonRight",
	"SeDenyRemoteInteractiveLogonRight",
	"SeDenyServiceLogonRight",
}

var requiredLogonRights = []string{"SeBatchLogonRight"}

type Account struct {
	Role     string `json:"role"`
	Name     string `json:"name"`
	Password string `json:"password"`
	SID      string `json:"sid"`
	TempDir  string `json:"temp_dir"`
}

type State struct {
	Version     int       `json:"version"`
	RuntimeRoot string    `json:"runtime_root"`
	Accounts    []Account `json:"accounts"`
	Filters     []string  `json:"filters,omitempty"`
}

type StatusResult struct {
	Ready    bool     `json:"ready"`
	Version  int      `json:"version,omitempty"`
	Missing  []string `json:"missing,omitempty"`
	Accounts []string `json:"accounts,omitempty"`
}

func LoadAccount(statePath, mode string, network bool) (Account, error) {
	state, err := readState(statePath)
	if err != nil {
		return Account{}, err
	}
	role := ""
	switch mode {
	case "read-only":
		role = "ROOff"
	case "workspace-write":
		role = "RWOff"
	default:
		return Account{}, fmt.Errorf("unsupported sandbox mode: %s", mode)
	}
	if network {
		role = role[:2] + "On"
	}
	for _, account := range state.Accounts {
		if account.Role == role {
			return account, nil
		}
	}
	return Account{}, fmt.Errorf("sandbox account role is missing: %s", role)
}

func LogonAccount(account Account) (windows.Token, error) {
	return logonBatch(account.Name, account.Password)
}

type userInfo1 struct {
	Name        *uint16
	Password    *uint16
	PasswordAge uint32
	Privilege   uint32
	HomeDir     *uint16
	Comment     *uint16
	Flags       uint32
	ScriptPath  *uint16
}

type lsaObjectAttributes struct {
	Length                   uint32
	RootDirectory            windows.Handle
	ObjectName               *lsaUnicodeString
	Attributes               uint32
	SecurityDescriptor       unsafe.Pointer
	SecurityQualityOfService unsafe.Pointer
}

type lsaUnicodeString struct {
	Length        uint16
	MaximumLength uint16
	Buffer        *uint16
}

func Install(statePath, prefix string) (State, error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return State{}, fmt.Errorf("setup requires an elevated administrator process")
	}
	if _, err := os.Stat(statePath); err == nil {
		return State{}, fmt.Errorf("sandbox setup state already exists: %s", statePath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return State{}, fmt.Errorf("inspect setup state: %w", err)
	}
	roles := []string{"ROOff", "ROOn", "RWOff", "RWOn"}
	runtimeRoot, err := sandboxRuntimeRoot(prefix)
	if err != nil {
		return State{}, err
	}
	if err := os.MkdirAll(runtimeRoot, 0o700); err != nil {
		return State{}, fmt.Errorf("create sandbox runtime root: %w", err)
	}
	state := State{Version: stateVersion, RuntimeRoot: runtimeRoot}
	for _, role := range roles {
		name := prefix + role
		if len(name) > 20 {
			_ = rollback(state)
			return State{}, fmt.Errorf("sandbox account name exceeds 20 characters: %s", name)
		}
		password, err := randomPassword()
		if err != nil {
			_ = rollback(state)
			return State{}, err
		}
		if err := addUser(name, password); err != nil {
			_ = rollback(state)
			return State{}, err
		}
		account := Account{Role: role, Name: name, Password: password}
		state.Accounts = append(state.Accounts, account)
		sid, _, _, err := windows.LookupSID("", name)
		if err != nil {
			_ = rollback(state)
			return State{}, fmt.Errorf("resolve SID for %s: %w", name, err)
		}
		account.SID = sid.String()
		account.TempDir = filepath.Join(runtimeRoot, name)
		if err := os.MkdirAll(account.TempDir, 0o700); err != nil {
			_ = rollback(state)
			return State{}, fmt.Errorf("create private temp for %s: %w", name, err)
		}
		if err := filesystem.GrantPrivateDirectory(account.TempDir, sid); err != nil {
			_ = rollback(state)
			return State{}, fmt.Errorf("grant private temp for %s: %w", name, err)
		}
		state.Accounts[len(state.Accounts)-1] = account
		if err := addDeniedLogonRights(sid); err != nil {
			_ = rollback(state)
			return State{}, fmt.Errorf("restrict logon for %s: %w", name, err)
		}
		if err := setLoginVisibility(name, false); err != nil {
			_ = rollback(state)
			return State{}, fmt.Errorf("hide %s from logon UI: %w", name, err)
		}
		if role == "ROOff" || role == "RWOff" {
			filters, err := firewall.Install(prefix, role, account.SID)
			if err != nil {
				_ = rollback(state)
				return State{}, err
			}
			state.Filters = append(state.Filters, filters...)
		}
	}
	if err := writeState(statePath, state); err != nil {
		_ = rollback(state)
		return State{}, err
	}
	return state, nil
}

func Status(statePath string) (StatusResult, error) {
	state, err := readState(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return StatusResult{Ready: false}, nil
		}
		return StatusResult{}, err
	}
	result := StatusResult{Ready: state.Version == stateVersion, Version: state.Version}
	for _, account := range state.Accounts {
		result.Accounts = append(result.Accounts, account.Name)
		if err := validateAccount(account); err != nil {
			result.Ready = false
			result.Missing = append(result.Missing, account.Name+": "+err.Error())
		}
	}
	if len(state.Accounts) != 4 {
		result.Ready = false
	}
	for _, filter := range state.Filters {
		exists, err := firewall.Exists(filter)
		if err != nil {
			return StatusResult{}, fmt.Errorf("inspect WFP filter %s: %w", filter, err)
		}
		if !exists {
			result.Missing = append(result.Missing, "WFP:"+filter)
		}
	}
	if len(state.Filters) != 8 {
		result.Missing = append(result.Missing, "WFP filters")
	}
	result.Ready = result.Ready && len(state.Accounts) == 4 && len(state.Filters) == 8 && len(result.Missing) == 0
	return result, nil
}

func validateAccount(account Account) error {
	exists, err := userExists(account.Name)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("account is missing")
	}
	sid, _, _, err := windows.LookupSID("", account.Name)
	if err != nil {
		return fmt.Errorf("resolve SID: %w", err)
	}
	if sid.String() != account.SID {
		return fmt.Errorf("SID does not match protected setup state")
	}
	if err := verifyDeniedLogonRights(sid); err != nil {
		return err
	}
	hidden, err := loginIsHidden(account.Name)
	if err != nil {
		return fmt.Errorf("check login visibility: %w", err)
	}
	if !hidden {
		return fmt.Errorf("account is visible on the login screen")
	}
	token, err := logonBatch(account.Name, account.Password)
	if err != nil {
		return fmt.Errorf("batch logon failed: %w", err)
	}
	defer token.Close()
	if token.IsElevated() {
		return fmt.Errorf("account token is elevated")
	}
	administrators, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return fmt.Errorf("resolve administrators SID: %w", err)
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return fmt.Errorf("read token groups: %w", err)
	}
	for _, group := range groups.AllGroups() {
		if group.Sid.Equals(administrators) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return fmt.Errorf("account is an enabled administrator")
		}
	}
	return nil
}

func Uninstall(statePath string) error {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return fmt.Errorf("uninstall requires an elevated administrator process")
	}
	state, err := readState(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var failures []error
	if removeErr := firewall.Remove(state.Filters); removeErr != nil {
		failures = append(failures, removeErr)
	}
	for index := len(state.Accounts) - 1; index >= 0; index-- {
		account := state.Accounts[index]
		if sid, sidErr := windows.StringToSid(account.SID); sidErr == nil {
			if removeErr := removeDeniedLogonRights(sid); removeErr != nil {
				failures = append(failures, fmt.Errorf("remove logon restrictions for %s: %w", account.Name, removeErr))
			}
		} else {
			failures = append(failures, fmt.Errorf("decode SID for %s: %w", account.Name, sidErr))
		}
		if visibilityErr := setLoginVisibility(account.Name, true); visibilityErr != nil {
			failures = append(failures, fmt.Errorf("restore login visibility for %s: %w", account.Name, visibilityErr))
		}
		if deleteErr := deleteUser(account.Name); deleteErr != nil {
			failures = append(failures, deleteErr)
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	if err := os.RemoveAll(state.RuntimeRoot); err != nil {
		return fmt.Errorf("remove sandbox runtime root: %w", err)
	}
	if err := os.Remove(statePath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove setup state: %w", err)
	}
	return nil
}

func rollback(state State) error {
	var failures []error
	if err := firewall.Remove(state.Filters); err != nil {
		failures = append(failures, err)
	}
	for index := len(state.Accounts) - 1; index >= 0; index-- {
		account := state.Accounts[index]
		if account.SID != "" {
			if sid, err := windows.StringToSid(account.SID); err == nil {
				_ = removeDeniedLogonRights(sid)
			}
		}
		_ = setLoginVisibility(account.Name, true)
		if err := deleteUser(account.Name); err != nil {
			failures = append(failures, err)
		}
	}
	if state.RuntimeRoot != "" {
		_ = os.RemoveAll(state.RuntimeRoot)
	}
	return errors.Join(failures...)
}

func sandboxRuntimeRoot(prefix string) (string, error) {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		return "", fmt.Errorf("ProgramData is unavailable")
	}
	return filepath.Join(programData, "DSCodeSandbox", prefix), nil
}

func addUser(name, password string) error {
	name16, _ := windows.UTF16PtrFromString(name)
	password16, _ := windows.UTF16PtrFromString(password)
	comment16, _ := windows.UTF16PtrFromString("DSCode native sandbox identity")
	info := userInfo1{
		Name:      name16,
		Password:  password16,
		Privilege: userPrivUser,
		Comment:   comment16,
		Flags:     ufScript | ufPasswordCantChange | ufNormalAccount | ufPasswordNeverExpire,
	}
	var parameterError uint32
	status, _, _ := procNetUserAdd.Call(0, 1, uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&parameterError)))
	runtime.KeepAlive(info)
	if status == nerrUserExists {
		return fmt.Errorf("sandbox account already exists: %s", name)
	}
	if status != 0 {
		return fmt.Errorf("create sandbox account %s (parameter %d): %w", name, parameterError, syscall.Errno(status))
	}
	return nil
}

func deleteUser(name string) error {
	name16, _ := windows.UTF16PtrFromString(name)
	status, _, _ := procNetUserDel.Call(0, uintptr(unsafe.Pointer(name16)))
	if status != 0 && status != nerrUserNotFound {
		return fmt.Errorf("delete sandbox account %s: %w", name, syscall.Errno(status))
	}
	return nil
}

func userExists(name string) (bool, error) {
	name16, _ := windows.UTF16PtrFromString(name)
	var buffer uintptr
	status, _, _ := procNetUserGetInfo.Call(0, uintptr(unsafe.Pointer(name16)), 1, uintptr(unsafe.Pointer(&buffer)))
	if buffer != 0 {
		_, _, _ = procNetApiBufferFree.Call(buffer)
	}
	if status == nerrUserNotFound {
		return false, nil
	}
	if status != 0 {
		return false, fmt.Errorf("query sandbox account %s: %w", name, syscall.Errno(status))
	}
	return true, nil
}

func addDeniedLogonRights(sid *windows.SID) error {
	return updateAccountRights(sid, allLogonRights(), false)
}

func removeDeniedLogonRights(sid *windows.SID) error {
	return updateAccountRights(sid, allLogonRights(), true)
}

func allLogonRights() []string {
	return append(append([]string{}, deniedLogonRights...), requiredLogonRights...)
}

func verifyDeniedLogonRights(sid *windows.SID) error {
	policy, err := openPolicy(policyLookupNames)
	if err != nil {
		return err
	}
	defer procLsaClose.Call(policy)
	var rightsPointer unsafe.Pointer
	var count uint32
	status, _, _ := procLsaEnumerateAccountRights.Call(
		policy,
		uintptr(unsafe.Pointer(sid)),
		uintptr(unsafe.Pointer(&rightsPointer)),
		uintptr(unsafe.Pointer(&count)),
	)
	if err := lsaError(status); err != nil {
		return fmt.Errorf("enumerate logon restrictions: %w", err)
	}
	defer procLsaFreeMemory.Call(uintptr(rightsPointer))
	found := make(map[string]bool, count)
	for _, right := range unsafe.Slice((*lsaUnicodeString)(rightsPointer), count) {
		found[windows.UTF16ToString(unsafe.Slice(right.Buffer, right.Length/2))] = true
	}
	for _, required := range allLogonRights() {
		if !found[required] {
			return fmt.Errorf("missing required account right %s", required)
		}
	}
	return nil
}

func updateAccountRights(sid *windows.SID, names []string, remove bool) error {
	policy, err := openPolicy(policyCreateAccount | policyLookupNames)
	if err != nil {
		return err
	}
	defer procLsaClose.Call(policy)
	rights := make([]lsaUnicodeString, len(names))
	buffers := make([][]uint16, len(names))
	for index, name := range names {
		buffers[index] = windows.StringToUTF16(name)
		rights[index] = lsaUnicodeString{
			Length:        uint16((len(buffers[index]) - 1) * 2),
			MaximumLength: uint16(len(buffers[index]) * 2),
			Buffer:        &buffers[index][0],
		}
	}
	var status uintptr
	if remove {
		status, _, _ = procLsaRemoveAccountRights.Call(
			policy,
			uintptr(unsafe.Pointer(sid)),
			0,
			uintptr(unsafe.Pointer(&rights[0])),
			uintptr(len(rights)),
		)
	} else {
		status, _, _ = procLsaAddAccountRights.Call(
			policy,
			uintptr(unsafe.Pointer(sid)),
			uintptr(unsafe.Pointer(&rights[0])),
			uintptr(len(rights)),
		)
	}
	runtime.KeepAlive(buffers)
	return lsaError(status)
}

func openPolicy(access uintptr) (uintptr, error) {
	attributes := lsaObjectAttributes{Length: uint32(unsafe.Sizeof(lsaObjectAttributes{}))}
	var policy uintptr
	status, _, _ := procLsaOpenPolicy.Call(
		0,
		uintptr(unsafe.Pointer(&attributes)),
		access,
		uintptr(unsafe.Pointer(&policy)),
	)
	return policy, lsaError(status)
}

func lsaError(status uintptr) error {
	if status == 0 {
		return nil
	}
	code, _, _ := procLsaNtStatusToWinError.Call(status)
	return syscall.Errno(code)
}

func setLoginVisibility(name string, visible bool) error {
	const keyPath = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, keyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if visible {
		err := key.DeleteValue(name)
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	return key.SetDWordValue(name, 0)
}

func loginIsHidden(name string) (bool, error) {
	const keyPath = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList`
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, keyPath, registry.QUERY_VALUE)
	if err != nil {
		return false, err
	}
	defer key.Close()
	value, _, err := key.GetIntegerValue(name)
	if err != nil {
		return false, err
	}
	return value == 0, nil
}

func logonBatch(name, password string) (windows.Token, error) {
	name16, _ := windows.UTF16PtrFromString(name)
	domain16, _ := windows.UTF16PtrFromString(".")
	password16, _ := windows.UTF16PtrFromString(password)
	var token windows.Token
	result, _, callErr := procLogonUser.Call(
		uintptr(unsafe.Pointer(name16)),
		uintptr(unsafe.Pointer(domain16)),
		uintptr(unsafe.Pointer(password16)),
		4,
		0,
		uintptr(unsafe.Pointer(&token)),
	)
	runtime.KeepAlive(password16)
	if result == 0 {
		return 0, callErr
	}
	return token, nil
}

func randomPassword() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate sandbox password: %w", err)
	}
	return "A1a!" + base64.RawURLEncoding.EncodeToString(bytes), nil
}

func writeState(path string, state State) error {
	plain, err := json.Marshal(state)
	if err != nil {
		return err
	}
	protected, err := protect(plain)
	if err != nil {
		return fmt.Errorf("protect setup state: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create setup state directory: %w", err)
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, protected, 0o600); err != nil {
		return fmt.Errorf("write setup state: %w", err)
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("commit setup state: %w", err)
	}
	return nil
}

func readState(path string) (State, error) {
	protected, err := os.ReadFile(path)
	if err != nil {
		return State{}, err
	}
	plain, err := unprotect(protected)
	if err != nil {
		return State{}, fmt.Errorf("unprotect setup state: %w", err)
	}
	var state State
	if err := json.Unmarshal(plain, &state); err != nil {
		return State{}, fmt.Errorf("decode setup state: %w", err)
	}
	return state, nil
}

func protect(plain []byte) ([]byte, error) {
	input := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var output windows.DataBlob
	if err := windows.CryptProtectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}

func unprotect(protected []byte) ([]byte, error) {
	if len(protected) == 0 {
		return nil, fmt.Errorf("empty protected state")
	}
	input := windows.DataBlob{Size: uint32(len(protected)), Data: &protected[0]}
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(&input, nil, nil, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(output.Data)))
	return append([]byte(nil), unsafe.Slice(output.Data, output.Size)...), nil
}
