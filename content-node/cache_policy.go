package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// CacheRule applies to a logical static URL prefix. Longest prefix wins.
// Headers travel in the normal response frame and survive in CacheStorage.
type CacheRule struct {
	Prefix       string   `json:"prefix"`
	CacheControl string   `json:"cacheControl"`
	Cache        string   `json:"cache"`
	Tags         []string `json:"tags"`
}

func (h *Handler) LoadCacheRules(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var rules []CacheRule
	if err := json.Unmarshal(data, &rules); err != nil {
		return err
	}
	if len(rules) > 1024 {
		return fmt.Errorf("too many cache rules")
	}
	for _, rule := range rules {
		if !strings.HasPrefix(rule.Prefix, "/") || strings.ContainsAny(rule.Prefix, "\r\n?#") || len(rule.Prefix) > 2048 {
			return fmt.Errorf("invalid cache prefix")
		}
		if len(rule.CacheControl) > 1024 || strings.ContainsAny(rule.CacheControl, "\r\n") {
			return fmt.Errorf("invalid Cache-Control")
		}
		if rule.Cache != "" && rule.Cache != "cache" && rule.Cache != "no-store" {
			return fmt.Errorf("cache must be cache or no-store")
		}
		if len(rule.Tags) > 32 {
			return fmt.Errorf("too many cache tags")
		}
		for _, tag := range rule.Tags {
			if len(tag) == 0 || len(tag) > 64 {
				return fmt.Errorf("invalid cache tag")
			}
			for _, c := range tag {
				if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("_.:-", c)) {
					return fmt.Errorf("invalid cache tag")
				}
			}
		}
	}
	h.cacheRules = rules
	return nil
}

func (h *Handler) staticCacheHeaders(path string) HeaderPairs {
	headers := HeaderPairs{{"cache-control", staticCacheControl(path)}}
	var selected *CacheRule
	for i := range h.cacheRules {
		rule := &h.cacheRules[i]
		if strings.HasPrefix(path, rule.Prefix) && (selected == nil || len(rule.Prefix) > len(selected.Prefix)) {
			selected = rule
		}
	}
	if selected == nil {
		return headers
	}
	if selected.CacheControl != "" {
		headers[0][1] = selected.CacheControl
	}
	if selected.Cache != "" {
		headers = append(headers, [2]string{"x-yurirtc-cache", selected.Cache})
	}
	if selected.Cache == "no-store" {
		headers[0][1] = "no-store"
	}
	if len(selected.Tags) > 0 {
		headers = append(headers, [2]string{"cache-tag", strings.Join(selected.Tags, ", ")})
	}
	return headers
}
