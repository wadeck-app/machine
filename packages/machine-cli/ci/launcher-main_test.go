package main

// Unit tests of the logic of ci/launcher-main.go.tmpl. This file is not built by ci/scripts/build-launcher.sh (the SDK's
// build.sh copies the generated main.go only): src/launcherGo.test.ts renders the template, drops this file next to it and
// runs `go test`.

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestConfigDirFromArgs(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"no argument", nil, ""},
		{"a command", []string{"status"}, ""},
		{"flag after the command", []string{"status", "--config-dir", "/tmp/x"}, "/tmp/x"},
		{"flag before the command", []string{"--config-dir", "/tmp/x", "status"}, "/tmp/x"},
		{"the last one wins, as in cli.ts", []string{"--config-dir", "/a", "status", "--config-dir", "/b"}, "/b"},
		{"flag without value is left to node to report", []string{"status", "--config-dir"}, ""},
		{"value that looks like an option is left to node to report", []string{"--config-dir", "--json", "status"}, ""},
		{"empty value is left to node to report", []string{"--config-dir", "", "status"}, ""},
		{"after -- it belongs to the remote command", []string{"run", "x", "--", "--config-dir", "/remote"}, ""},
		{"before -- still counts", []string{"run", "x", "--config-dir", "/here", "--", "--config-dir", "/remote"}, "/here"},
		{"--config is not our flag", []string{"--config", "/tmp/x", "status"}, ""},
		{"a leading absolute path is not a config dir", []string{"/tmp/x", "status"}, ""},
		{"--config-dir=value is not accepted by cli.ts", []string{"--config-dir=/tmp/x"}, ""},
		{"a path with spaces is one value", []string{"--config-dir", "/tmp/a b", "status"}, "/tmp/a b"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := configDirFromArgs(c.args); got != c.want {
				t.Fatalf("configDirFromArgs(%q) = %q, want %q", c.args, got, c.want)
			}
		})
	}
}

func TestResolveConfigDirPrecedence(t *testing.T) {
	const def = "/home/u/.config/machine"
	cases := []struct {
		name string
		args []string
		env  string
		want string
	}{
		{"default", []string{"status"}, "", def},
		{"env beats the default", []string{"status"}, "/env", "/env"},
		{"flag beats env", []string{"status", "--config-dir", "/flag"}, "/env", "/flag"},
		{"a flag after -- does not beat env", []string{"run", "x", "--", "--config-dir", "/remote"}, "/env", "/env"},
		{"an invalid flag falls back to env", []string{"status", "--config-dir"}, "/env", "/env"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveConfigDir(c.args, c.env, def); got != c.want {
				t.Fatalf("resolveConfigDir(%q, %q) = %q, want %q", c.args, c.env, got, c.want)
			}
		})
	}
}

func TestCheckNodeMissingNamesCauseRequirementAndFix(t *testing.T) {
	err := checkNode(func(string) (string, error) { return "", errors.New("executable file not found in $PATH") })
	if err == nil {
		t.Fatal("expected an error when node is not in PATH")
	}
	for _, want := range []string{"machine", "`node` was not found in PATH", "executable file not found", "Node.js 24 or newer", "https://nodejs.org", "PATH of the process that starts machine"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message %q does not contain %q", err.Error(), want)
		}
	}
}

func TestCheckNodeFound(t *testing.T) {
	var asked string
	err := checkNode(func(name string) (string, error) { asked = name; return "/usr/bin/node", nil })
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if asked != "node" {
		t.Fatalf("looked up %q, want node", asked)
	}
}

func TestReportNodeMissingWritesTheDailyLauncherLog(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cfg")
	reportNodeMissing(dir, errors.New("boom"))
	matches, err := filepath.Glob(filepath.Join(dir, "logs", "*-launcher.log"))
	if err != nil || len(matches) != 1 {
		t.Fatalf("expected one daily launcher log under %s, got %v (err %v)", dir, matches, err)
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "[ERROR] [launcher] boom") {
		t.Fatalf("log line missing: %q", data)
	}
}

func TestConfigDirFromArgsDoesNotMutateTheArguments(t *testing.T) {
	args := []string{"--config-dir", "/x", "run", "a", "--", "b c"}
	before := append([]string(nil), args...)
	_ = configDirFromArgs(args)
	if !reflect.DeepEqual(args, before) {
		t.Fatalf("arguments changed: %q", args)
	}
}
