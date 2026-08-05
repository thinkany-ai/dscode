//go:build windows

package runner

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/filesystem"
	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/setup"
	"golang.org/x/sys/windows"
)

func TestSandboxChildHelper(t *testing.T) {
	if os.Getenv("DSCODE_SANDBOX_TEST_CHILD") != "1" {
		return
	}
	separator := -1
	for index, argument := range os.Args {
		if argument == "--" {
			separator = index
			break
		}
	}
	if separator < 0 || separator+1 >= len(os.Args) {
		os.Exit(125)
	}
	requestPath := os.Args[separator+1]
	data, err := os.ReadFile(requestPath)
	if err != nil {
		os.Exit(125)
	}
	if err := os.Remove(requestPath); err != nil {
		os.Exit(125)
	}
	var request Request
	if err := json.Unmarshal(data, &request); err != nil {
		os.Exit(125)
	}
	exitCode, err := RunChild(request)
	if err != nil {
		os.Exit(125)
	}
	os.Exit(int(exitCode))
}

func TestFilesystemProbeHelper(t *testing.T) {
	if os.Getenv("DSCODE_FILESYSTEM_PROBE") != "1" {
		return
	}
	result := filesystemProbeResult{}
	if data, err := os.ReadFile(os.Getenv("DSCODE_TEST_INPUT")); err == nil {
		result.Read = string(data)
	} else {
		result.Read = "denied"
	}
	write := func(environmentKey string) string {
		if err := os.WriteFile(os.Getenv(environmentKey), []byte("written"), 0o600); err != nil {
			return "denied"
		}
		return "allowed"
	}
	result.Workspace = write("DSCODE_TEST_WORKSPACE")
	result.Outside = write("DSCODE_TEST_OUTSIDE")
	result.Escape = write("DSCODE_TEST_ESCAPE")
	if err := os.WriteFile(filepath.Join(os.TempDir(), "temp-write.txt"), []byte("written"), 0o600); err != nil {
		result.Temp = "denied"
	} else {
		result.Temp = "allowed"
	}
	data, err := json.Marshal(result)
	if err != nil {
		os.Exit(125)
	}
	if err := os.WriteFile(os.Getenv("DSCODE_TEST_RESULT"), data, 0o600); err != nil {
		os.Exit(125)
	}
}

func TestNetworkProbeHelper(t *testing.T) {
	if os.Getenv("DSCODE_NETWORK_PROBE") != "1" {
		return
	}
	outbound := "blocked"
	connection, err := net.DialTimeout("tcp", os.Getenv("DSCODE_TEST_ADDRESS"), 2*time.Second)
	if err == nil {
		outbound = "allowed"
		_ = connection.Close()
	}
	inbound := "blocked"
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err == nil {
		defer listener.Close()
		if tcp, ok := listener.(*net.TCPListener); ok {
			_ = tcp.SetDeadline(time.Now().Add(3 * time.Second))
		}
		if err := os.WriteFile(os.Getenv("DSCODE_TEST_INBOUND_ADDRESS"), []byte(listener.Addr().String()), 0o600); err != nil {
			os.Exit(125)
		}
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			defer connection.Close()
			_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
			nonce := os.Getenv("DSCODE_TEST_INBOUND_NONCE")
			buffer := make([]byte, len(nonce))
			if _, readErr := io.ReadFull(connection, buffer); readErr == nil && string(buffer) == nonce {
				if _, writeErr := io.WriteString(connection, nonce); writeErr == nil {
					inbound = "allowed"
				}
			}
		}
	}
	result := fmt.Sprintf("outbound:%s,inbound:%s", outbound, inbound)
	if err := os.WriteFile(os.Getenv("DSCODE_TEST_RESULT"), []byte(result), 0o600); err != nil {
		os.Exit(125)
	}
}

func TestRunPreservesExitCodeAndEnvironment(t *testing.T) {
	t.Parallel()
	exitCode, err := Run(Request{
		Version: ProtocolVersion,
		Command: "powershell.exe",
		Args: []string{
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"if ($env:DSCODE_RUNNER_TEST -ne 'AB-中文-CD') { exit 9 }; exit 7",
		},
		Cwd: t.TempDir(),
		Env: map[string]string{"DSCODE_RUNNER_TEST": "AB-中文-CD"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != 7 {
		t.Fatalf("exit code = %d, want 7", exitCode)
	}
}

func TestSandboxFilesystemModes(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("requires elevated setup for temporary sandbox identities")
	}
	prefix := fmt.Sprintf("DF%08X", uint32(time.Now().UnixNano()))
	statePath := filepath.Join(t.TempDir(), "state.bin")
	state, err := setup.Install(statePath, prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := setup.Uninstall(statePath); err != nil {
			t.Errorf("cleanup sandbox identities: %v", err)
		}
	})

	root := t.TempDir()
	workspace := filepath.Join(root, "workspace")
	outsideDir := filepath.Join(root, "outside")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatal(err)
	}
	input := filepath.Join(workspace, "input.txt")
	if err := os.WriteFile(input, []byte("read-ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	junction := filepath.Join(workspace, "escape")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", junction, outsideDir).CombinedOutput(); err != nil {
		t.Fatalf("create test junction: %v: %s", err, output)
	}

	readAccount := accountByRole(t, state, "ROOff")
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	helperArgs := []string{"-test.run=TestSandboxChildHelper", "--"}
	exitCode, output, err := runWithCapturedStdout(Request{
		Version:       ProtocolVersion,
		StatePath:     statePath,
		Mode:          "read-only",
		Command:       "cmd.exe",
		Args:          []string{"/d", "/c", "echo", "sandbox-stdout"},
		Cwd:           workspace,
		HelperCommand: helper,
		HelperArgs:    helperArgs,
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != 0 {
		t.Fatalf("sandbox cmd launch exit code = %d", exitCode)
	}
	if !strings.Contains(output, "sandbox-stdout") {
		t.Fatalf("sandbox stdout was not forwarded: %q", output)
	}
	readResult := filepath.Join(readAccount.TempDir, "read-result.json")
	result := runFilesystemProbe(t, Request{
		Version:   ProtocolVersion,
		StatePath: statePath,
		Mode:      "read-only",
		Command:   "powershell.exe",
		Cwd:       workspace,
		Env: map[string]string{
			"DSCODE_TEST_INPUT":     input,
			"DSCODE_TEST_WORKSPACE": filepath.Join(workspace, "write.txt"),
			"DSCODE_TEST_OUTSIDE":   filepath.Join(outsideDir, "outside.txt"),
			"DSCODE_TEST_ESCAPE":    filepath.Join(junction, "escape.txt"),
			"DSCODE_TEST_RESULT":    readResult,
		},
		HelperCommand: helper,
		HelperArgs:    helperArgs,
	})
	if result.Read != "read-ok" || result.Workspace != "denied" || result.Outside != "denied" || result.Escape != "denied" || result.Temp != "allowed" {
		t.Fatalf("unexpected read-only result: %+v", result)
	}
	assertNoWorkspaceACE(t, workspace, readAccount.SID)

	writeAccount := accountByRole(t, state, "RWOff")
	writeResult := filepath.Join(writeAccount.TempDir, "write-result.json")
	result = runFilesystemProbe(t, Request{
		Version:   ProtocolVersion,
		StatePath: statePath,
		Mode:      "workspace-write",
		Command:   "powershell.exe",
		Cwd:       workspace,
		Env: map[string]string{
			"DSCODE_TEST_INPUT":     input,
			"DSCODE_TEST_WORKSPACE": filepath.Join(workspace, "write.txt"),
			"DSCODE_TEST_OUTSIDE":   filepath.Join(outsideDir, "outside.txt"),
			"DSCODE_TEST_ESCAPE":    filepath.Join(junction, "escape.txt"),
			"DSCODE_TEST_RESULT":    writeResult,
		},
		HelperCommand: helper,
		HelperArgs:    helperArgs,
	})
	if result.Read != "read-ok" || result.Workspace != "allowed" || result.Outside != "denied" || result.Escape != "denied" || result.Temp != "allowed" {
		t.Fatalf("unexpected workspace-write result: %+v", result)
	}
	assertNoWorkspaceACE(t, workspace, writeAccount.SID)
}

func runWithCapturedStdout(request Request) (uint32, string, error) {
	original, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	if err != nil {
		return 0, "", err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return 0, "", err
	}
	defer reader.Close()
	if err := windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(writer.Fd())); err != nil {
		writer.Close()
		return 0, "", err
	}
	exitCode, runErr := Run(request)
	_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, original)
	_ = writer.Close()
	data, readErr := io.ReadAll(reader)
	if runErr != nil {
		return exitCode, string(data), runErr
	}
	return exitCode, string(data), readErr
}

func TestSandboxNetworkModes(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("requires elevated setup for temporary sandbox identities")
	}
	prefix := fmt.Sprintf("DN%08X", uint32(time.Now().UnixNano()))
	statePath := filepath.Join(t.TempDir(), "state.bin")
	state, err := setup.Install(statePath, prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := setup.Uninstall(statePath); err != nil {
			t.Errorf("cleanup sandbox identities: %v", err)
		}
	})

	testAddress := "github.com:443"
	preflight, err := net.DialTimeout("tcp", testAddress, 3*time.Second)
	if err != nil {
		t.Skipf("external network preflight is unavailable: %v", err)
	}
	_ = preflight.Close()

	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	helperArgs := []string{"-test.run=TestSandboxChildHelper", "--"}
	for _, testCase := range []struct {
		name    string
		network bool
		role    string
		want    string
	}{
		{name: "offline", network: false, role: "ROOff", want: "outbound:blocked,inbound:blocked"},
		{name: "online", network: true, role: "ROOn", want: "outbound:allowed,inbound:allowed"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			account := accountByRole(t, state, testCase.role)
			resultPath := filepath.Join(account.TempDir, "network-result.txt")
			addressPath := filepath.Join(account.TempDir, "inbound-address.txt")
			_ = os.Remove(addressPath)
			if err := os.WriteFile(resultPath, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			sid, err := windows.StringToSid(account.SID)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := filesystem.GrantFileModify(resultPath, sid)
			if err != nil {
				t.Fatal(err)
			}
			defer grant.Revoke()

			nonce := fmt.Sprintf("dscode-%d", time.Now().UnixNano())
			stopProbe := make(chan struct{})
			probeResult := make(chan bool, 1)
			go func() {
				probeResult <- connectToSandboxListener(addressPath, nonce, stopProbe)
			}()
			exitCode, err := Run(Request{
				Version:   ProtocolVersion,
				StatePath: statePath,
				Mode:      "read-only",
				Network:   testCase.network,
				Command:   helper,
				Args:      []string{"-test.run=TestNetworkProbeHelper"},
				Cwd:       workspace,
				Env: map[string]string{
					"DSCODE_NETWORK_PROBE":        "1",
					"DSCODE_TEST_ADDRESS":         testAddress,
					"DSCODE_TEST_INBOUND_ADDRESS": addressPath,
					"DSCODE_TEST_INBOUND_NONCE":   nonce,
					"DSCODE_TEST_RESULT":          resultPath,
				},
				TimeoutMS:     8000,
				HelperCommand: helper,
				HelperArgs:    helperArgs,
			})
			close(stopProbe)
			connected := <-probeResult
			if err != nil {
				t.Fatal(err)
			}
			if exitCode != 0 {
				t.Fatalf("network probe exit code = %d", exitCode)
			}
			data, err := os.ReadFile(resultPath)
			if err != nil {
				t.Fatal(err)
			}
			if got := string(data); got != testCase.want {
				t.Fatalf("network access = %s, want %s", got, testCase.want)
			}
			if connected != testCase.network {
				t.Fatalf("host-to-sandbox handshake = %v, want %v", connected, testCase.network)
			}
		})
	}
}

func connectToSandboxListener(addressPath, nonce string, stop <-chan struct{}) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-stop:
			return false
		default:
		}
		data, err := os.ReadFile(addressPath)
		if err != nil || len(data) == 0 {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		connection, err := net.DialTimeout("tcp", string(data), 2*time.Second)
		if err != nil {
			return false
		}
		defer connection.Close()
		_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := io.WriteString(connection, nonce); err != nil {
			return false
		}
		buffer := make([]byte, len(nonce))
		if _, err := io.ReadFull(connection, buffer); err != nil {
			return false
		}
		return string(buffer) == nonce
	}
	return false
}

type filesystemProbeResult struct {
	Read      string `json:"read"`
	Workspace string `json:"workspace"`
	Outside   string `json:"outside"`
	Escape    string `json:"escape"`
	Temp      string `json:"temp"`
}

func runFilesystemProbe(t *testing.T, request Request) filesystemProbeResult {
	t.Helper()
	account, err := setup.LoadAccount(request.StatePath, request.Mode, request.Network)
	if err != nil {
		t.Fatal(err)
	}
	sid, err := windows.StringToSid(account.SID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(request.Env["DSCODE_TEST_RESULT"], nil, 0o600); err != nil {
		t.Fatal(err)
	}
	resultGrant, err := filesystem.GrantFileModify(request.Env["DSCODE_TEST_RESULT"], sid)
	if err != nil {
		t.Fatal(err)
	}
	defer resultGrant.Revoke()
	helper, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	request.Command = helper
	request.Args = []string{"-test.run=TestFilesystemProbeHelper"}
	request.Env["DSCODE_FILESYSTEM_PROBE"] = "1"
	exitCode, err := Run(request)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(request.Env["DSCODE_TEST_RESULT"])
	if err != nil {
		paths := []string{
			request.Env["DSCODE_TEST_WORKSPACE"],
			request.Env["DSCODE_TEST_OUTSIDE"],
			request.Env["DSCODE_TEST_ESCAPE"],
			filepath.Join(filepath.Dir(request.Env["DSCODE_TEST_RESULT"]), "temp-write.txt"),
		}
		states := make([]string, 0, len(paths))
		for _, path := range paths {
			_, statErr := os.Stat(path)
			states = append(states, fmt.Sprintf("%s=%v", path, statErr))
		}
		t.Fatalf("filesystem probe exit code = %d; read result: %v; writes: %v", exitCode, err, states)
	}
	var result filesystemProbeResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode filesystem probe: %v: %s", err, data)
	}
	result.Read = string([]byte(result.Read))
	return result
}

func accountByRole(t *testing.T, state setup.State, role string) setup.Account {
	t.Helper()
	for _, account := range state.Accounts {
		if account.Role == role {
			return account
		}
	}
	t.Fatalf("missing account role %s", role)
	return setup.Account{}
}

func assertNoWorkspaceACE(t *testing.T, workspace, sidString string) {
	t.Helper()
	sid, err := windows.StringToSid(sidString)
	if err != nil {
		t.Fatal(err)
	}
	if err := filepath.WalkDir(workspace, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		found, err := filesystem.ContainsSID(path, sid)
		if err != nil {
			return err
		}
		if found {
			return fmt.Errorf("ACL for %s still contains sandbox SID %s", path, sidString)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestRunTimeoutKillsDescendants(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "survived.txt")
	script := "$child = Start-Process powershell.exe -PassThru -ArgumentList @(" +
		"'-NoProfile','-NonInteractive','-Command'," +
		"'Start-Sleep -Milliseconds 1200; Set-Content -LiteralPath ''" +
		powershellLiteral(marker) + "'' -Value survived'); " +
		"Start-Sleep -Seconds 30"
	exitCode, err := Run(Request{
		Version:   ProtocolVersion,
		Command:   "powershell.exe",
		Args:      []string{"-NoProfile", "-NonInteractive", "-Command", script},
		Cwd:       root,
		TimeoutMS: 300,
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != timeoutExitCode {
		t.Fatalf("exit code = %d, want %d", exitCode, timeoutExitCode)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("descendant survived job termination: %v", err)
	}
}

func powershellLiteral(value string) string {
	result := ""
	for _, character := range value {
		if character == '\'' {
			result += "''"
		} else {
			result += string(character)
		}
	}
	return result
}
