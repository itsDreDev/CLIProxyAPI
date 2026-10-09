// Package subscriptiongui contains the local subscription management dashboard.
package subscriptiongui

import (
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"io/fs"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

// all: includes Next.js assets under _next, which embed normally excludes.
//
//go:embed all:web
var assets embed.FS

var (
	cspOnce sync.Once
	csp     string
)

// Available reports whether the frontend export was bundled before compilation.
func Available() bool {
	_, err := assets.ReadFile("web/index.html")
	return err == nil
}

// ContentSecurityPolicy permits only the exact inline bootstrap scripts in the
// compiled Next.js export, without allowing arbitrary inline JavaScript.
func ContentSecurityPolicy() string {
	cspOnce.Do(func() {
		sources := []string{"'self'"}
		seen := make(map[string]bool)
		scripts := regexp.MustCompile(`(?s)<script\b[^>]*>(.*?)</script>`)
		_ = fs.WalkDir(assets, "web", func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".html") {
				return nil
			}
			body, errRead := assets.ReadFile(path)
			if errRead != nil {
				return nil
			}
			for _, script := range scripts.FindAllSubmatch(body, -1) {
				if len(script[1]) == 0 {
					continue
				}
				hash := sha256.Sum256(script[1])
				source := "'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'"
				if !seen[source] {
					seen[source] = true
					sources = append(sources, source)
				}
			}
			return nil
		})
		csp = "default-src 'self'; script-src " + strings.Join(sources, " ") + "; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
	})
	return csp
}

// Handler serves the bundled Next.js export without a Node.js runtime.
func Handler() http.Handler {
	files, _ := fs.Sub(assets, "web")
	if Available() {
		return http.FileServer(http.FS(files))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "Subscription Desk assets are missing. Run npm ci --prefix gui and npm run build --prefix gui, then rebuild the Go binary.", http.StatusServiceUnavailable)
	})
}
