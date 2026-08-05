//go:build windows

package setup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/firewall"
	"golang.org/x/sys/windows"
)

func TestProtectedStateRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.bin")
	want := State{
		Version:  stateVersion,
		Accounts: []Account{{Role: "test", Name: "test", Password: "secret", SID: "S-1-0-0"}},
	}
	if err := writeState(path, want); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == "secret" || string(raw) == string(mustJSON(t, want)) {
		t.Fatal("setup state was stored without DPAPI protection")
	}
	got, err := readState(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Accounts[0].Password != want.Accounts[0].Password {
		t.Fatalf("password = %q, want %q", got.Accounts[0].Password, want.Accounts[0].Password)
	}
}

func TestInstallStatusAndUninstall(t *testing.T) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Skip("requires an elevated Windows test process")
	}
	prefix := fmt.Sprintf("DS%08X", uint32(time.Now().UnixNano()))
	statePath := filepath.Join(t.TempDir(), "state.bin")
	state, err := Install(statePath, prefix)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := Uninstall(statePath); err != nil {
			t.Errorf("cleanup sandbox accounts: %v", err)
		}
	})
	if len(state.Accounts) != 4 {
		t.Fatalf("accounts = %d, want 4", len(state.Accounts))
	}
	if len(state.Filters) != 8 {
		t.Fatalf("WFP filters = %d, want 8", len(state.Filters))
	}
	status, err := Status(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Ready {
		t.Fatalf("setup is not ready: %+v", status)
	}
	if err := Uninstall(statePath); err != nil {
		t.Fatal(err)
	}
	for _, account := range state.Accounts {
		exists, err := userExists(account.Name)
		if err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("sandbox account still exists after uninstall: %s", account.Name)
		}
	}
	for _, filter := range state.Filters {
		exists, err := firewall.Exists(filter)
		if err != nil {
			t.Fatal(err)
		}
		if exists {
			t.Fatalf("WFP filter still exists after uninstall: %s", filter)
		}
	}
	if _, err := os.Stat(state.RuntimeRoot); !os.IsNotExist(err) {
		t.Fatalf("sandbox runtime root still exists after uninstall: %v", err)
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
