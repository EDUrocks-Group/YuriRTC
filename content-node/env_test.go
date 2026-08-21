package main

import "testing"

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
