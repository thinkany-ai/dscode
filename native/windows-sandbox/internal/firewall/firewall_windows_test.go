//go:build windows

package firewall

import (
	"testing"
	"unsafe"
)

func TestWFPStructLayout(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("WFP layout assertions cover the supported x64 and ARM64 builds")
	}
	item := filter{}
	checks := []struct {
		name string
		got  uintptr
		want uintptr
	}{
		{name: "filter size", got: unsafe.Sizeof(item), want: 200},
		{name: "condition size", got: unsafe.Sizeof(filterCondition{}), want: 40},
		{name: "provider key", got: unsafe.Offsetof(item.providerKey), want: 40},
		{name: "condition count", got: unsafe.Offsetof(item.numFilterConditions), want: 112},
		{name: "condition pointer", got: unsafe.Offsetof(item.filterCondition), want: 120},
		{name: "action", got: unsafe.Offsetof(item.action), want: 128},
		{name: "context", got: unsafe.Offsetof(item.context), want: 152},
		{name: "effective weight", got: unsafe.Offsetof(item.effectiveWeight), want: 184},
	}
	for _, check := range checks {
		if check.got != check.want {
			t.Errorf("%s offset/size = %d, want %d", check.name, check.got, check.want)
		}
	}
}
