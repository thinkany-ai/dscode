//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/runner"
	"github.com/thinkany-ai/dscode/native/windows-sandbox/internal/setup"
)

func main() {
	if len(os.Args) != 3 {
		usage()
	}
	switch os.Args[1] {
	case "run":
		run(os.Args[2], false)
	case "run-child":
		run(os.Args[2], true)
	case "setup-install":
		if _, err := setup.Install(os.Args[2], setup.DefaultPrefix); err != nil {
			fail(err)
		}
	case "setup-status":
		status, err := setup.Status(os.Args[2])
		if err != nil {
			fail(err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(status); err != nil {
			fail(err)
		}
	case "setup-uninstall":
		if err := setup.Uninstall(os.Args[2]); err != nil {
			fail(err)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: dscode-windows-sandbox <run|run-child|setup-install|setup-status|setup-uninstall> <path>")
	os.Exit(2)
}

func run(requestPath string, child bool) {
	data, err := os.ReadFile(requestPath)
	if err != nil {
		fail(err)
	}
	if err := os.Remove(requestPath); err != nil {
		fail(fmt.Errorf("remove consumed request: %w", err))
	}
	var request runner.Request
	if err := json.Unmarshal(data, &request); err != nil {
		fail(fmt.Errorf("decode request: %w", err))
	}
	var exitCode uint32
	if child {
		exitCode, err = runner.RunChild(request)
	} else {
		exitCode, err = runner.Run(request)
	}
	if err != nil {
		fail(err)
	}
	os.Exit(int(exitCode))
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "windows sandbox runner: %v\n", err)
	os.Exit(125)
}
