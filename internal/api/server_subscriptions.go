package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/subscriptiongui"
)

func (s *Server) registerSubscriptionGUI() {
	assets := http.StripPrefix("/subscriptions/", subscriptiongui.Handler())
	s.engine.GET("/subscriptions", func(c *gin.Context) {
		c.Redirect(http.StatusTemporaryRedirect, "/subscriptions/")
	})
	serve := func(c *gin.Context) {
		if s.cfg == nil || s.cfg.Home.Enabled || s.cfg.RemoteManagement.DisableControlPanel {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Content-Security-Policy", subscriptiongui.ContentSecurityPolicy())
		assets.ServeHTTP(c.Writer, c.Request)
	}
	s.engine.GET("/subscriptions/*asset", serve)
	s.engine.HEAD("/subscriptions/*asset", serve)
}
