package api

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/subscriptiongui"
)

func TestSubscriptionGUIAssetsAndAvailability(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name           string
		home, disabled bool
		want           int
	}{
		{"enabled", false, false, http.StatusOK},
		{"home mode", true, false, http.StatusNotFound},
		{"panel disabled", false, true, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want := tc.want
			if want == http.StatusOK && !subscriptiongui.Available() {
				want = http.StatusServiceUnavailable
			}
			cfg := &config.Config{}
			cfg.Home.Enabled = tc.home
			cfg.RemoteManagement.DisableControlPanel = tc.disabled
			s := &Server{cfg: cfg, engine: gin.New()}
			s.registerSubscriptionGUI()
			for _, path := range []string{"/subscriptions/", "/subscriptions/favicon.svg"} {
				response := httptest.NewRecorder()
				s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
				if response.Code != want {
					t.Fatalf("%s: status=%d, want=%d", path, response.Code, want)
				}
				if want == http.StatusOK {
					if response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Header().Get("Content-Security-Policy"), "connect-src 'self'") {
						t.Fatalf("%s: missing dashboard privacy headers", path)
					}
					if path == "/subscriptions/" && !strings.Contains(response.Body.String(), "Subscription Desk") {
						t.Fatal("dashboard entry page was not served")
					}
					if path == "/subscriptions/" {
						match := regexp.MustCompile(`src="(/subscriptions/_next/[^" ]+\.js)"`).FindStringSubmatch(response.Body.String())
						if len(match) != 2 {
							t.Fatal("Next.js bootstrap asset is missing")
						}
						assetResponse := httptest.NewRecorder()
						s.engine.ServeHTTP(assetResponse, httptest.NewRequest(http.MethodGet, match[1], nil))
						if assetResponse.Code != http.StatusOK {
							t.Fatalf("Next.js _next asset was not embedded: %d", assetResponse.Code)
						}
					}
				}
			}
		})
	}
}

func TestSubscriptionGUIRejectsMissingAndEscapedAssets(t *testing.T) {
	if !subscriptiongui.Available() {
		t.Skip("run npm run build --prefix gui to test exported assets")
	}
	s := &Server{cfg: &config.Config{}, engine: gin.New()}
	s.registerSubscriptionGUI()
	for _, path := range []string{"/subscriptions/config.yaml", "/subscriptions/../../config.yaml", "/subscriptions/web/", "/subscriptions/assets.go"} {
		response := httptest.NewRecorder()
		s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s: status=%d, want 404", path, response.Code)
		}
	}
	response := httptest.NewRecorder()
	s.engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/subscriptions", nil))
	if response.Code != http.StatusTemporaryRedirect || response.Header().Get("Location") != "/subscriptions/" {
		t.Fatalf("unexpected dashboard redirect: %d %s", response.Code, response.Header().Get("Location"))
	}
}
