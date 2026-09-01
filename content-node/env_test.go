package main

import (
	"testing"

	"github.com/pion/sctp"
)

func TestYuriRTCEnvUsesFallbackWhenUnset(t *testing.T) {
	const suffix = "TEST_UNSET"
	t.Setenv("YURIRTC_"+suffix, "")
	t.Setenv("EDUROCKS_"+suffix, "")

	if got := yurirtcEnv(suffix, "default"); got != "default" {
		t.Fatalf("yurirtcEnv() = %q, want fallback", got)
	}
}

func TestYuriRTCEnvAcceptsLegacyName(t *testing.T) {
	const suffix = "TEST_LEGACY"
	t.Setenv("YURIRTC_"+suffix, "")
	t.Setenv("EDUROCKS_"+suffix, "legacy")

	if got := yurirtcEnv(suffix, "default"); got != "legacy" {
		t.Fatalf("yurirtcEnv() = %q, want legacy value", got)
	}
}

func TestYuriRTCEnvPrefersCurrentName(t *testing.T) {
	const suffix = "TEST_PRECEDENCE"
	t.Setenv("YURIRTC_"+suffix, "current")
	t.Setenv("EDUROCKS_"+suffix, "legacy")

	if got := yurirtcEnv(suffix, "default"); got != "current" {
		t.Fatalf("yurirtcEnv() = %q, want current value", got)
	}
}

func TestCapacityEnvUsesLegacyName(t *testing.T) {
	t.Setenv("YURIRTC_CAPACITY_USERS", "")
	t.Setenv("EDUROCKS_CAPACITY_USERS", "20000")

	if got := capacityEnv("USERS", "100"); got != "20000" {
		t.Fatalf("capacityEnv() = %q, want legacy value", got)
	}
}

func TestResolveSCTPCongestionControl(t *testing.T) {
	tests := []struct {
		input    string
		selector uint32
		name     string
		wantErr  bool
	}{
		{input: "", selector: sctp.CwndCAStepUseCUBIC, name: "cubic"},
		{input: " CUBIC ", selector: sctp.CwndCAStepUseCUBIC, name: "cubic"},
		{input: "reno", selector: 0, name: "reno"},
		{input: "bbr", wantErr: true},
	}
	for _, test := range tests {
		selector, name, err := resolveSCTPCongestionControl(test.input)
		if test.wantErr {
			if err == nil {
				t.Errorf("resolveSCTPCongestionControl(%q) succeeded", test.input)
			}
			continue
		}
		if err != nil || selector != test.selector || name != test.name {
			t.Errorf(
				"resolveSCTPCongestionControl(%q) = (%d, %q, %v), want (%d, %q, nil)",
				test.input, selector, name, err, test.selector, test.name,
			)
		}
	}
}
