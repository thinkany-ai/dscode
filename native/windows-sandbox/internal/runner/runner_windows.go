//go:build windows

package runner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unsafe"

	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/filesystem"
	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/setup"
	"golang.org/x/sys/windows"
)

const timeoutExitCode = 124

var procCreateProcessWithToken = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateProcessWithTokenW")
var procCreateRestrictedToken = windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
var procGetProcessWindowStation = windows.NewLazySystemDLL("user32.dll").NewProc("GetProcessWindowStation")
var procCreateDesktop = windows.NewLazySystemDLL("user32.dll").NewProc("CreateDesktopW")
var procCloseDesktop = windows.NewLazySystemDLL("user32.dll").NewProc("CloseDesktop")

func Run(request Request) (exitCode uint32, runErr error) {
	command, cwd, err := validateRequest(request)
	if err != nil {
		return 0, err
	}
	if request.StatePath == "" {
		return launchProcess(request, command, cwd, os.Environ(), 0, launchCurrent, true)
	}
	release, err := acquirePolicyMutex()
	if err != nil {
		return 0, err
	}
	defer release()
	account, err := setup.LoadAccount(request.StatePath, request.Mode, request.Network)
	if err != nil {
		return 0, fmt.Errorf("load sandbox identity: %w", err)
	}
	sid, err := windows.StringToSid(account.SID)
	if err != nil {
		return 0, fmt.Errorf("decode sandbox SID: %w", err)
	}
	workspaceGrant, err := filesystem.GrantWorkspace(cwd, sid, request.Mode == "workspace-write")
	if err != nil {
		return 0, err
	}
	defer func() {
		if err := workspaceGrant.Revoke(); err != nil && runErr == nil {
			runErr = fmt.Errorf("revoke workspace access: %w", err)
		}
	}()
	return runBroker(request, account, sid)
}

func RunChild(request Request) (exitCode uint32, runErr error) {
	defer func() {
		if request.ResultPath == "" {
			return
		}
		result := childResult{ExitCode: exitCode}
		if runErr != nil {
			result.Error = runErr.Error()
		}
		if data, err := json.Marshal(result); err == nil {
			_ = os.WriteFile(request.ResultPath, data, 0o600)
		}
	}()
	if !request.Child || request.SandboxSID == "" || request.StatePath != "" || !strings.HasPrefix(request.Desktop, `Winsta0\DSCodeSandbox-`) {
		return 0, fmt.Errorf("invalid child runner request")
	}
	command, cwd, err := validateRequest(request)
	if err != nil {
		return 0, err
	}
	sandboxSID, err := windows.StringToSid(request.SandboxSID)
	if err != nil {
		return 0, fmt.Errorf("decode child sandbox SID: %w", err)
	}
	var primary windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_ADJUST_PRIVILEGES,
		&primary,
	); err != nil {
		return 0, fmt.Errorf("open child runner token: %w", err)
	}
	defer primary.Close()
	user, err := primary.GetTokenUser()
	if err != nil {
		return 0, fmt.Errorf("read child runner identity: %w", err)
	}
	if !user.User.Sid.Equals(sandboxSID) {
		return 0, fmt.Errorf("child runner identity does not match request")
	}
	restricted, err := writeRestrictedToken(primary, sandboxSID)
	if err != nil {
		return 0, fmt.Errorf("create write-restricted token: %w", err)
	}
	defer restricted.Close()
	baseEnvironment := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(entry), "DSCODE_SANDBOX_TEST_CHILD=") {
			baseEnvironment = append(baseEnvironment, entry)
		}
	}
	return launchProcess(request, command, cwd, baseEnvironment, restricted, launchRestricted, true)
}

func runBroker(request Request, account setup.Account, sid *windows.SID) (exitCode uint32, runErr error) {
	desktop, restoreDesktopAccess, err := grantDesktopAccess(sid)
	if err != nil {
		return 0, fmt.Errorf("grant sandbox desktop access: %w", err)
	}
	defer func() {
		if err := restoreDesktopAccess(); err != nil && runErr == nil {
			runErr = fmt.Errorf("restore sandbox desktop access: %w", err)
		}
	}()

	helper := request.HelperCommand
	prefix := append([]string(nil), request.HelperArgs...)
	if helper == "" {
		var err error
		helper, err = os.Executable()
		if err != nil {
			return 0, fmt.Errorf("resolve sandbox helper: %w", err)
		}
		prefix = []string{"run-child"}
	}
	helper, err = filepath.Abs(helper)
	if err != nil {
		return 0, fmt.Errorf("resolve sandbox helper path: %w", err)
	}
	helperGrant, err := filesystem.GrantExecutable(helper, sid)
	if err != nil {
		return 0, fmt.Errorf("grant sandbox helper access: %w", err)
	}
	defer func() {
		if err := helperGrant.Revoke(); err != nil && runErr == nil {
			runErr = fmt.Errorf("revoke sandbox helper access: %w", err)
		}
	}()

	child := request
	child.StatePath = ""
	child.Child = true
	child.SandboxSID = account.SID
	child.Desktop = desktop
	child.HelperCommand = ""
	child.HelperArgs = nil
	resultFile, err := os.CreateTemp(account.TempDir, "dscode-result-*.json")
	if err != nil {
		return 0, fmt.Errorf("create child result: %w", err)
	}
	resultPath := resultFile.Name()
	if err := resultFile.Close(); err != nil {
		os.Remove(resultPath)
		return 0, fmt.Errorf("close child result: %w", err)
	}
	if err := os.Remove(resultPath); err != nil {
		return 0, fmt.Errorf("prepare child result: %w", err)
	}
	child.ResultPath = resultPath
	defer os.Remove(resultPath)
	requestFile, err := os.CreateTemp(account.TempDir, "dscode-child-*.json")
	if err != nil {
		return 0, fmt.Errorf("create child request: %w", err)
	}
	requestPath := requestFile.Name()
	if err := json.NewEncoder(requestFile).Encode(child); err != nil {
		requestFile.Close()
		os.Remove(requestPath)
		return 0, fmt.Errorf("write child request: %w", err)
	}
	if err := requestFile.Close(); err != nil {
		os.Remove(requestPath)
		return 0, fmt.Errorf("close child request: %w", err)
	}
	defer os.Remove(requestPath)

	token, err := setup.LogonAccount(account)
	if err != nil {
		return 0, fmt.Errorf("log on sandbox identity: %w", err)
	}
	defer token.Close()
	environment, err := sandboxEnvironment(token, account, request)
	if err != nil {
		return 0, err
	}
	broker := Request{
		Version:   ProtocolVersion,
		Command:   helper,
		Args:      append(prefix, requestPath),
		Cwd:       account.TempDir,
		Env:       environment,
		TimeoutMS: request.TimeoutMS,
	}
	brokerExitCode, brokerErr := launchProcess(broker, helper, account.TempDir, nil, token, launchWithToken, true)
	if brokerErr != nil {
		return 0, brokerErr
	}
	data, err := os.ReadFile(resultPath)
	if err != nil {
		return brokerExitCode, fmt.Errorf("read child result after broker exit %d: %w", brokerExitCode, err)
	}
	var result childResult
	if err := json.Unmarshal(data, &result); err != nil {
		return brokerExitCode, fmt.Errorf("decode child result: %w", err)
	}
	if result.Error != "" {
		return result.ExitCode, fmt.Errorf("sandbox child: %s", result.Error)
	}
	return result.ExitCode, nil
}

type childResult struct {
	ExitCode uint32 `json:"exit_code"`
	Error    string `json:"error,omitempty"`
}

type launchKind uint8

const (
	launchCurrent launchKind = iota
	launchWithToken
	launchRestricted
)

func launchProcess(
	request Request,
	command string,
	cwd string,
	baseEnvironment []string,
	token windows.Token,
	kind launchKind,
	inheritStandardHandles bool,
) (uint32, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("create job object: %w", err)
	}
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return 0, fmt.Errorf("configure job object: %w", err)
	}

	var handles [3]windows.Handle
	closeHandles := func() {}
	if inheritStandardHandles {
		handles, closeHandles, err = inheritedStandardHandles()
		if err != nil {
			return 0, err
		}
		defer closeHandles()
	}
	application, err := windows.UTF16PtrFromString(command)
	if err != nil {
		return 0, fmt.Errorf("encode command: %w", err)
	}
	commandLine, err := windows.UTF16PtrFromString(
		windows.ComposeCommandLine(append([]string{command}, request.Args...)),
	)
	if err != nil {
		return 0, fmt.Errorf("encode command line: %w", err)
	}
	currentDirectory, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return 0, fmt.Errorf("encode working directory: %w", err)
	}
	environment, err := environmentBlock(baseEnvironment, request.Env)
	if err != nil {
		return 0, err
	}

	startup := windows.StartupInfo{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	if kind == launchRestricted {
		startup.Desktop, err = windows.UTF16PtrFromString(request.Desktop)
		if err != nil {
			return 0, fmt.Errorf("encode sandbox desktop: %w", err)
		}
	}
	if inheritStandardHandles {
		startup.Flags = windows.STARTF_USESTDHANDLES
		startup.StdInput = handles[0]
		startup.StdOutput = handles[1]
		startup.StdErr = handles[2]
	}
	process := windows.ProcessInformation{}
	flags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_UNICODE_ENVIRONMENT)
	if kind != launchRestricted {
		flags |= windows.CREATE_BREAKAWAY_FROM_JOB
	}
	if kind != launchCurrent {
		flags |= windows.CREATE_NO_WINDOW
	}
	startupPointer := &startup
	var extended *windows.StartupInfoEx
	// CreateProcessWithTokenW rejects PROC_THREAD_ATTRIBUTE_HANDLE_LIST. That path starts only the
	// trusted broker; the broker's launchRestricted child is the untrusted process and uses this list.
	if inheritStandardHandles && kind != launchWithToken {
		attributes, err := windows.NewProcThreadAttributeList(1)
		if err != nil {
			return 0, fmt.Errorf("create process attribute list: %w", err)
		}
		defer attributes.Delete()
		if err := attributes.Update(
			windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
			unsafe.Pointer(&handles[0]),
			uintptr(len(handles))*unsafe.Sizeof(handles[0]),
		); err != nil {
			return 0, fmt.Errorf("restrict inherited handles: %w", err)
		}
		extended = &windows.StartupInfoEx{
			StartupInfo:             startup,
			ProcThreadAttributeList: attributes.List(),
		}
		extended.Cb = uint32(unsafe.Sizeof(*extended))
		startupPointer = &extended.StartupInfo
		flags |= windows.EXTENDED_STARTUPINFO_PRESENT
	}
	switch kind {
	case launchCurrent:
		err = windows.CreateProcess(
			application,
			commandLine,
			nil,
			nil,
			inheritStandardHandles,
			flags,
			&environment[0],
			currentDirectory,
			startupPointer,
			&process,
		)
	case launchWithToken:
		err = createProcessWithToken(token, application, commandLine, flags, &environment[0], currentDirectory, startupPointer, &process)
	case launchRestricted:
		err = windows.CreateProcessAsUser(token, application, commandLine, nil, nil, inheritStandardHandles, flags, &environment[0], currentDirectory, startupPointer, &process)
	default:
		return 0, fmt.Errorf("unknown process launch kind")
	}
	if err != nil {
		return 0, fmt.Errorf("create suspended process: %w", err)
	}
	defer windows.CloseHandle(process.Process)
	defer windows.CloseHandle(process.Thread)

	if kind != launchRestricted {
		if err := windows.AssignProcessToJobObject(job, process.Process); err != nil {
			_ = windows.TerminateProcess(process.Process, 125)
			return 0, fmt.Errorf("assign process to job object: %w", err)
		}
	}
	if _, err := windows.ResumeThread(process.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("resume process: %w", err)
	}

	wait := uint32(windows.INFINITE)
	if request.TimeoutMS > 0 {
		wait = request.TimeoutMS
	}
	event, err := windows.WaitForSingleObject(process.Process, wait)
	if err != nil {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("wait for process: %w", err)
	}
	if event == uint32(windows.WAIT_TIMEOUT) {
		_ = windows.TerminateJobObject(job, timeoutExitCode)
		_, _ = windows.WaitForSingleObject(process.Process, windows.INFINITE)
		return timeoutExitCode, nil
	}
	if event != windows.WAIT_OBJECT_0 {
		_ = windows.TerminateJobObject(job, 125)
		return 0, fmt.Errorf("unexpected process wait result: %d", event)
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return 0, fmt.Errorf("read process exit code: %w", err)
	}
	return exitCode, nil
}

func sandboxEnvironment(token windows.Token, account setup.Account, request Request) (map[string]string, error) {
	base, err := token.Environ(false)
	if err != nil {
		return nil, fmt.Errorf("read sandbox account environment: %w", err)
	}
	values := make(map[string]string)
	for _, entry := range base {
		key, value, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			values[key] = value
		}
	}
	for _, key := range []string{"SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "PSModulePath"} {
		if value := os.Getenv(key); value != "" {
			values[key] = value
		}
	}
	for key, value := range request.Env {
		values[key] = value
	}
	values["HOME"] = account.TempDir
	values["USERPROFILE"] = account.TempDir
	values["APPDATA"] = account.TempDir
	values["LOCALAPPDATA"] = account.TempDir
	values["TEMP"] = account.TempDir
	values["TMP"] = account.TempDir
	values["DSCODE_SANDBOX"] = request.Mode
	if strings.HasSuffix(strings.ToLower(request.HelperCommand), ".test.exe") {
		values["DSCODE_SANDBOX_TEST_CHILD"] = "1"
	}
	return values, nil
}

func writeRestrictedToken(token windows.Token, sandboxSID *windows.SID) (windows.Token, error) {
	everyone, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		return 0, err
	}
	restricted := []windows.SIDAndAttributes{
		{Sid: sandboxSID},
		{Sid: everyone},
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return 0, err
	}
	for _, group := range groups.AllGroups() {
		if group.Attributes&windows.SE_GROUP_LOGON_ID == windows.SE_GROUP_LOGON_ID {
			restricted = append(restricted, windows.SIDAndAttributes{Sid: group.Sid})
		}
	}
	var result windows.Token
	created, _, callErr := procCreateRestrictedToken.Call(
		uintptr(token),
		0xD,
		0,
		0,
		0,
		0,
		uintptr(len(restricted)),
		uintptr(unsafe.Pointer(&restricted[0])),
		uintptr(unsafe.Pointer(&result)),
	)
	if created == 0 {
		return 0, callErr
	}
	if err := setTokenDefaultDACL(result, restricted); err != nil {
		result.Close()
		return 0, err
	}
	privilegeName, _ := windows.UTF16PtrFromString("SeChangeNotifyPrivilege")
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, privilegeName, &luid); err != nil {
		result.Close()
		return 0, err
	}
	privileges := windows.Tokenprivileges{PrivilegeCount: 1}
	privileges.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	if err := windows.AdjustTokenPrivileges(result, false, &privileges, 0, nil, nil); err != nil {
		result.Close()
		return 0, err
	}
	return result, nil
}

func setTokenDefaultDACL(token windows.Token, sids []windows.SIDAndAttributes) error {
	entries := make([]windows.EXPLICIT_ACCESS, 0, len(sids))
	for _, item := range sids {
		entries = append(entries, windows.EXPLICIT_ACCESS{
			AccessPermissions: windows.GENERIC_ALL,
			AccessMode:        windows.GRANT_ACCESS,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_UNKNOWN,
				TrusteeValue: windows.TrusteeValueFromSID(item.Sid),
			},
		})
	}
	dacl, err := windows.ACLFromEntries(entries, nil)
	if err != nil {
		return err
	}
	info := struct {
		DefaultDACL *windows.ACL
	}{DefaultDACL: dacl}
	return windows.SetTokenInformation(
		token,
		windows.TokenDefaultDacl,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
}

func grantDesktopAccess(sid *windows.SID) (string, func() error, error) {
	windowStation, _, callErr := procGetProcessWindowStation.Call()
	if windowStation == 0 {
		return "", nil, callErr
	}
	name := fmt.Sprintf("DSCodeSandbox-%d-%d", os.Getpid(), time.Now().UnixNano())
	name16, _ := windows.UTF16PtrFromString(name)
	desktop, _, callErr := procCreateDesktop.Call(
		uintptr(unsafe.Pointer(name16)),
		0,
		0,
		0,
		0x000F01FF,
		0,
	)
	if desktop == 0 {
		return "", nil, callErr
	}
	type securedObject struct {
		handle      windows.Handle
		permissions windows.ACCESS_MASK
	}
	objects := []securedObject{
		{handle: windows.Handle(windowStation), permissions: 0x000F037F},
		{handle: windows.Handle(desktop), permissions: 0x000F01FF},
	}
	restores := make([]func() error, 0, len(objects))
	for _, object := range objects {
		restore, err := grantWindowObject(object.handle, object.permissions, sid)
		if err != nil {
			for index := len(restores) - 1; index >= 0; index-- {
				_ = restores[index]()
			}
			_, _, _ = procCloseDesktop.Call(desktop)
			return "", nil, err
		}
		restores = append(restores, restore)
	}
	return `Winsta0\` + name, func() error {
		var failures []error
		for index := len(restores) - 1; index >= 0; index-- {
			if err := restores[index](); err != nil {
				failures = append(failures, err)
			}
		}
		if closed, _, err := procCloseDesktop.Call(desktop); closed == 0 {
			failures = append(failures, err)
		}
		return errors.Join(failures...)
	}, nil
}

func grantWindowObject(handle windows.Handle, permissions windows.ACCESS_MASK, sid *windows.SID) (func() error, error) {
	descriptor, err := windows.GetSecurityInfo(handle, windows.SE_WINDOW_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return nil, err
	}
	original, _, err := descriptor.DACL()
	if err != nil {
		return nil, err
	}
	entry := windows.EXPLICIT_ACCESS{
		AccessPermissions: permissions,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}
	updated, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{entry}, original)
	if err != nil {
		return nil, err
	}
	if err := windows.SetSecurityInfo(handle, windows.SE_WINDOW_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, updated, nil); err != nil {
		return nil, err
	}
	return func() error {
		return windows.SetSecurityInfo(handle, windows.SE_WINDOW_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, original, nil)
	}, nil
}

func createProcessWithToken(
	token windows.Token,
	application *uint16,
	commandLine *uint16,
	flags uint32,
	environment *uint16,
	currentDirectory *uint16,
	startup *windows.StartupInfo,
	process *windows.ProcessInformation,
) error {
	result, _, callErr := procCreateProcessWithToken.Call(
		uintptr(token),
		0,
		uintptr(unsafe.Pointer(application)),
		uintptr(unsafe.Pointer(commandLine)),
		uintptr(flags),
		uintptr(unsafe.Pointer(environment)),
		uintptr(unsafe.Pointer(currentDirectory)),
		uintptr(unsafe.Pointer(startup)),
		uintptr(unsafe.Pointer(process)),
	)
	if result == 0 {
		return callErr
	}
	return nil
}

func acquirePolicyMutex() (func(), error) {
	name, _ := windows.UTF16PtrFromString(`Local\DSCodeWindowsSandboxPolicy`)
	mutex, err := windows.CreateMutex(nil, false, name)
	if err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return nil, fmt.Errorf("create sandbox policy mutex: %w", err)
	}
	event, err := windows.WaitForSingleObject(mutex, windows.INFINITE)
	if err != nil || (event != windows.WAIT_OBJECT_0 && event != windows.WAIT_ABANDONED) {
		_ = windows.CloseHandle(mutex)
		return nil, fmt.Errorf("acquire sandbox policy mutex: event=%d err=%w", event, err)
	}
	return func() {
		_ = windows.ReleaseMutex(mutex)
		_ = windows.CloseHandle(mutex)
	}, nil
}

func validateRequest(request Request) (string, string, error) {
	if request.Version != ProtocolVersion {
		return "", "", fmt.Errorf("unsupported protocol version: %d", request.Version)
	}
	if strings.TrimSpace(request.Command) == "" {
		return "", "", fmt.Errorf("command is required")
	}
	command, err := exec.LookPath(request.Command)
	if err != nil {
		return "", "", fmt.Errorf("resolve command %q: %w", request.Command, err)
	}
	command, err = filepath.Abs(command)
	if err != nil {
		return "", "", fmt.Errorf("resolve command path: %w", err)
	}
	cwd, err := filepath.Abs(request.Cwd)
	if err != nil {
		return "", "", fmt.Errorf("resolve working directory: %w", err)
	}
	info, err := os.Stat(cwd)
	if err != nil {
		return "", "", fmt.Errorf("inspect working directory: %w", err)
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("working directory is not a directory: %s", cwd)
	}
	return command, cwd, nil
}

func inheritedStandardHandles() ([3]windows.Handle, func(), error) {
	standard := []uint32{windows.STD_INPUT_HANDLE, windows.STD_OUTPUT_HANDLE, windows.STD_ERROR_HANDLE}
	var handles [3]windows.Handle
	for index, kind := range standard {
		source, err := windows.GetStdHandle(kind)
		if err != nil {
			closeWindowsHandles(handles[:index])
			return handles, func() {}, fmt.Errorf("get standard handle: %w", err)
		}
		if err := windows.DuplicateHandle(
			windows.CurrentProcess(),
			source,
			windows.CurrentProcess(),
			&handles[index],
			0,
			true,
			windows.DUPLICATE_SAME_ACCESS,
		); err != nil {
			closeWindowsHandles(handles[:index])
			return handles, func() {}, fmt.Errorf("duplicate standard handle: %w", err)
		}
	}
	return handles, func() { closeWindowsHandles(handles[:]) }, nil
}

func closeWindowsHandles(handles []windows.Handle) {
	for _, handle := range handles {
		if handle != 0 && handle != windows.InvalidHandle {
			_ = windows.CloseHandle(handle)
		}
	}
}

func environmentBlock(base []string, overrides map[string]string) ([]uint16, error) {
	values := make(map[string]string, len(base)+len(overrides))
	for _, entry := range base {
		key, _, ok := strings.Cut(entry, "=")
		if ok && key != "" {
			values[strings.ToUpper(key)] = entry
		}
	}
	for key, value := range overrides {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("invalid environment entry: %q", key)
		}
		values[strings.ToUpper(key)] = key + "=" + value
	}
	entries := make([]string, 0, len(values))
	for _, entry := range values {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToUpper(entries[i]) < strings.ToUpper(entries[j])
	})
	block := strings.Join(entries, "\x00") + "\x00\x00"
	return utf16.Encode([]rune(block)), nil
}
