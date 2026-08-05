//go:build windows

package firewall

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	fwpActionBlock            = 0x1001
	fwpSecurityDescriptorType = 14
	fwpmFilterFlagPersistent  = 1
	fwpFilterNotFound         = 0x80320003
	fwpNotFound               = 0x80320008
)

var (
	fwpuclnt                     = windows.NewLazySystemDLL("fwpuclnt.dll")
	procFwpmEngineOpen           = fwpuclnt.NewProc("FwpmEngineOpen0")
	procFwpmEngineClose          = fwpuclnt.NewProc("FwpmEngineClose0")
	procFwpmFilterAdd            = fwpuclnt.NewProc("FwpmFilterAdd0")
	procFwpmFilterDeleteByKey    = fwpuclnt.NewProc("FwpmFilterDeleteByKey0")
	procFwpmFilterGetByKey       = fwpuclnt.NewProc("FwpmFilterGetByKey0")
	procFwpmFreeMemory           = fwpuclnt.NewProc("FwpmFreeMemory0")
	procGetSecurityDescriptorLen = windows.NewLazySystemDLL("advapi32.dll").NewProc("GetSecurityDescriptorLength")

	conditionALEUserID = windows.GUID{Data1: 0xaf043a0a, Data2: 0xb34d, Data3: 0x4f86, Data4: [8]byte{0x97, 0x9c, 0xc9, 0x03, 0x71, 0xaf, 0x6e, 0x66}}
	sublayerUniversal  = windows.GUID{Data1: 0xeebecc03, Data2: 0xced4, Data3: 0x4380, Data4: [8]byte{0x81, 0x9a, 0x27, 0x34, 0x39, 0x7b, 0x2b, 0x74}}
	filterLayers       = []windows.GUID{
		{Data1: 0xc38d57d1, Data2: 0x05a7, Data3: 0x4c33, Data4: [8]byte{0x90, 0x4f, 0x7f, 0xbc, 0xee, 0xe6, 0x0e, 0x82}},
		{Data1: 0x4a72393b, Data2: 0x319f, Data3: 0x44bc, Data4: [8]byte{0x84, 0xc3, 0xba, 0x54, 0xdc, 0xb3, 0xb6, 0xb4}},
		{Data1: 0x1247d66d, Data2: 0x0b60, Data3: 0x4a15, Data4: [8]byte{0x8d, 0x44, 0x71, 0x55, 0xd0, 0xf5, 0x3a, 0x0c}},
		{Data1: 0x55a650e1, Data2: 0x5f0a, Data3: 0x4eca, Data4: [8]byte{0xa6, 0x53, 0x88, 0xf5, 0x3b, 0x26, 0xaa, 0x8c}},
	}
)

type byteBlob struct {
	size uint32
	data *byte
}

type value struct {
	typeID int32
	_      uint32
	data   uintptr
}

type displayData struct {
	name        *uint16
	description *uint16
}

type filterCondition struct {
	fieldKey       windows.GUID
	matchType      int32
	conditionValue value
}

type action struct {
	typeID uint32
	key    windows.GUID
}

type filter struct {
	filterKey           windows.GUID
	displayData         displayData
	flags               uint32
	_                   uint32
	providerKey         *windows.GUID
	providerData        byteBlob
	layerKey            windows.GUID
	subLayerKey         windows.GUID
	weight              value
	numFilterConditions uint32
	_                   uint32
	filterCondition     *filterCondition
	action              action
	_                   uint32
	context             windows.GUID
	reserved            *windows.GUID
	filterID            uint64
	effectiveWeight     value
}

func Install(prefix, role, sid string) ([]string, error) {
	engine, err := openEngine()
	if err != nil {
		return nil, err
	}
	defer closeEngine(engine)
	descriptor, err := windows.SecurityDescriptorFromString("D:(A;;CC;;;" + sid + ")")
	if err != nil {
		return nil, fmt.Errorf("build WFP user condition: %w", err)
	}
	length, _, callErr := procGetSecurityDescriptorLen.Call(uintptr(unsafe.Pointer(descriptor)))
	if length == 0 {
		return nil, fmt.Errorf("measure WFP user condition: %w", callErr)
	}
	blob := byteBlob{size: uint32(length), data: (*byte)(unsafe.Pointer(descriptor))}
	condition := filterCondition{
		fieldKey: conditionALEUserID,
		conditionValue: value{
			typeID: fwpSecurityDescriptorType,
			data:   uintptr(unsafe.Pointer(&blob)),
		},
	}
	installed := make([]string, 0, len(filterLayers))
	for index, layer := range filterLayers {
		key, err := windows.GenerateGUID()
		if err != nil {
			_ = removeWithEngine(engine, installed)
			return nil, fmt.Errorf("generate WFP filter key: %w", err)
		}
		name, _ := windows.UTF16PtrFromString(fmt.Sprintf("DSCode %s %s network block %d", prefix, role, index+1))
		description, _ := windows.UTF16PtrFromString("Block network access for a DSCode sandbox identity")
		item := filter{
			filterKey:           key,
			displayData:         displayData{name: name, description: description},
			flags:               fwpmFilterFlagPersistent,
			layerKey:            layer,
			subLayerKey:         sublayerUniversal,
			numFilterConditions: 1,
			filterCondition:     &condition,
			action:              action{typeID: fwpActionBlock},
		}
		var filterID uint64
		result, _, _ := procFwpmFilterAdd.Call(
			uintptr(engine),
			uintptr(unsafe.Pointer(&item)),
			0,
			uintptr(unsafe.Pointer(&filterID)),
		)
		if result != 0 {
			_ = removeWithEngine(engine, installed)
			return nil, fmt.Errorf("add WFP filter for layer %s: 0x%08X", layer.String(), uint32(result))
		}
		installed = append(installed, key.String())
	}
	return installed, nil
}

func Remove(keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	engine, err := openEngine()
	if err != nil {
		return err
	}
	defer closeEngine(engine)
	return removeWithEngine(engine, keys)
}

func removeWithEngine(engine windows.Handle, keys []string) error {
	var failures []error
	for _, keyString := range keys {
		key, err := windows.GUIDFromString(keyString)
		if err != nil {
			failures = append(failures, fmt.Errorf("decode WFP filter key %q: %w", keyString, err))
			continue
		}
		result, _, _ := procFwpmFilterDeleteByKey.Call(uintptr(engine), uintptr(unsafe.Pointer(&key)))
		if result != 0 && uint32(result) != fwpFilterNotFound && uint32(result) != fwpNotFound {
			failures = append(failures, fmt.Errorf("delete WFP filter %s: 0x%08X", keyString, uint32(result)))
		}
	}
	return errors.Join(failures...)
}

func Exists(keyString string) (bool, error) {
	key, err := windows.GUIDFromString(keyString)
	if err != nil {
		return false, err
	}
	engine, err := openEngine()
	if err != nil {
		return false, err
	}
	defer closeEngine(engine)
	var item unsafe.Pointer
	result, _, _ := procFwpmFilterGetByKey.Call(uintptr(engine), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&item)))
	if item != nil {
		_, _, _ = procFwpmFreeMemory.Call(uintptr(unsafe.Pointer(&item)))
	}
	if result == 0 {
		return true, nil
	}
	if uint32(result) == fwpFilterNotFound || uint32(result) == fwpNotFound {
		return false, nil
	}
	return false, fmt.Errorf("get WFP filter %s: 0x%08X", keyString, uint32(result))
}

func openEngine() (windows.Handle, error) {
	var engine windows.Handle
	result, _, _ := procFwpmEngineOpen.Call(0, uintptr(^uint32(0)), 0, 0, uintptr(unsafe.Pointer(&engine)))
	if result != 0 {
		return 0, fmt.Errorf("open WFP engine: 0x%08X", uint32(result))
	}
	return engine, nil
}

func closeEngine(engine windows.Handle) {
	_, _, _ = procFwpmEngineClose.Call(uintptr(engine))
}
