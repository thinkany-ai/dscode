//go:build windows

package filesystem

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type grantedPath struct {
	path      string
	recursive bool
}

type Grant struct {
	paths []grantedPath
	sid   string
}

func GrantWorkspace(root string, sid *windows.SID, writable bool) (*Grant, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve workspace: %w", err)
	}
	grant := &Grant{sid: sid.String()}
	permission := "(OI)(CI)(RX)"
	if writable {
		permission = "(OI)(CI)(M)"
	}
	if err := icacls(abs, "/grant", "*"+grant.sid+":"+permission, "/T", "/C", "/Q"); err != nil {
		_ = grant.Revoke()
		return nil, fmt.Errorf("grant workspace access: %w", err)
	}
	grant.paths = append(grant.paths, grantedPath{path: abs, recursive: true})
	return grant, nil
}

func GrantPrivateDirectory(root string, sid *windows.SID) error {
	return icacls(root, "/grant", "*"+sid.String()+":(OI)(CI)(M)", "/T", "/C", "/Q")
}

func GrantExecutable(path string, sid *windows.SID) (*Grant, error) {
	grant := &Grant{sid: sid.String()}
	if err := icacls(path, "/grant", "*"+grant.sid+":(RX)"); err != nil {
		return nil, err
	}
	grant.paths = append(grant.paths, grantedPath{path: path})
	return grant, nil
}

func GrantFileModify(path string, sid *windows.SID) (*Grant, error) {
	grant := &Grant{sid: sid.String()}
	if err := icacls(path, "/grant", "*"+grant.sid+":(M)"); err != nil {
		return nil, err
	}
	grant.paths = append(grant.paths, grantedPath{path: path})
	return grant, nil
}

func (grant *Grant) Revoke() error {
	var first error
	for index := len(grant.paths) - 1; index >= 0; index-- {
		path := grant.paths[index]
		args := []string{"/remove:g", "*" + grant.sid}
		if path.recursive {
			args = append(args, "/T", "/C", "/Q")
		}
		if err := icacls(path.path, args...); err != nil && first == nil {
			first = err
		}
	}
	grant.paths = nil
	return first
}

func ContainsSID(path string, sid *windows.SID) (bool, error) {
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return false, err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil || dacl == nil {
		return false, err
	}
	for index := uint32(0); index < uint32(dacl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, index, &ace); err != nil {
			return false, err
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID.Equals(sid) {
			return true, nil
		}
	}
	return false, nil
}

func icacls(path string, args ...string) error {
	commandArgs := append([]string{path}, args...)
	output, err := exec.Command("icacls.exe", commandArgs...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %s: %w: %s", strings.Join(commandArgs, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}
