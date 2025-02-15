/*
Copyright 2022 Gravitational, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package ingress

import (
	"net"
	"net/http"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	prommodel "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/require"

	"github.com/gravitational/teleport/lib/utils"
)

func TestIngressReporter(t *testing.T) {
	reporter, err := NewReporter("0.0.0.0:3080")
	require.NoError(t, err)
	conn := newConn(t, "localhost:3080")
	t.Cleanup(func() {
		activeConnections.Reset()
		acceptedConnections.Reset()
		authenticatedConnectionsAccepted.Reset()
		authenticatedConnectionsActive.Reset()
	})

	reporter.ConnectionAccepted(SSH, conn)
	require.Equal(t, 1, getAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 1, getActiveConnections(PathALPN, SSH))
	require.Equal(t, 0, getAuthenticatedAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getAuthenticatedActiveConnections(PathALPN, SSH))

	reporter.ConnectionClosed(SSH, conn)
	require.Equal(t, 1, getAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getActiveConnections(PathALPN, SSH))
	require.Equal(t, 0, getAuthenticatedAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getAuthenticatedActiveConnections(PathALPN, SSH))

	reporter.ConnectionAuthenticated(SSH, conn)
	require.Equal(t, 1, getAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getActiveConnections(PathALPN, SSH))
	require.Equal(t, 1, getAuthenticatedAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 1, getAuthenticatedActiveConnections(PathALPN, SSH))

	reporter.AuthenticatedConnectionClosed(SSH, conn)
	require.Equal(t, 1, getAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getActiveConnections(PathALPN, SSH))
	require.Equal(t, 1, getAuthenticatedAcceptedConnections(PathALPN, SSH))
	require.Equal(t, 0, getAuthenticatedActiveConnections(PathALPN, SSH))
}

func TestPath(t *testing.T) {
	reporter, err := NewReporter("0.0.0.0:3080")
	require.NoError(t, err)
	alpn := newConn(t, "localhost:3080")
	direct := newConn(t, "localhost:3022")
	unknown := newConn(t, "localhost")

	require.Equal(t, PathALPN, reporter.getIngressPath(alpn))
	require.Equal(t, PathDirect, reporter.getIngressPath(direct))
	require.Equal(t, PathUnknown, reporter.getIngressPath(unknown))
}

type wrappedConn struct {
	net.Conn
	addr net.Addr
}

func newConn(t *testing.T, addr string) net.Conn {
	netaddr, err := utils.ParseAddr(addr)
	require.NoError(t, err)

	return &wrappedConn{
		addr: netaddr,
	}
}

func (c *wrappedConn) LocalAddr() net.Addr {
	return c.addr
}

func getAcceptedConnections(path, service string) int {
	return getCounterValue(acceptedConnections, path, service)
}

func getActiveConnections(path, service string) int {
	return getGaugeValue(activeConnections, path, service)
}

func getAuthenticatedAcceptedConnections(path, service string) int {
	return getCounterValue(authenticatedConnectionsAccepted, path, service)
}

func getAuthenticatedActiveConnections(path, service string) int {
	return getGaugeValue(authenticatedConnectionsActive, path, service)
}

func getCounterValue(metric *prometheus.CounterVec, path, service string) int {
	var m = &prommodel.Metric{}
	if err := metric.WithLabelValues(path, service).Write(m); err != nil {
		return 0
	}
	return int(m.Counter.GetValue())
}

func getGaugeValue(metric *prometheus.GaugeVec, path, service string) int {
	var m = &prommodel.Metric{}
	if err := metric.WithLabelValues(path, service).Write(m); err != nil {
		return 0
	}
	return int(m.Gauge.GetValue())
}

func TestHTTPConnStateReporter(t *testing.T) {
	reporter, err := NewReporter("")
	require.NoError(t, err)

	l, err := net.Listen("tcp", "localhost:0")
	require.NoError(t, err)

	stateC := make(chan http.ConnState, 2)
	reporterFunc := HTTPConnStateReporter(Web, reporter)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	s := http.Server{
		Handler: handler,
		ConnState: func(c net.Conn, state http.ConnState) {
			reporterFunc(c, state)
			if state == http.StateNew || state == http.StateClosed {
				stateC <- state
			}
		},
	}

	go s.Serve(l)
	t.Cleanup(func() { require.NoError(t, s.Close()) })
	t.Cleanup(func() {
		activeConnections.Reset()
		acceptedConnections.Reset()
		authenticatedConnectionsAccepted.Reset()
		authenticatedConnectionsActive.Reset()
	})

	require.Equal(t, 0, getAcceptedConnections(PathDirect, Web))
	require.Equal(t, 0, getActiveConnections(PathDirect, Web))
	require.Equal(t, 0, getAuthenticatedAcceptedConnections(PathDirect, Web))
	require.Equal(t, 0, getAuthenticatedActiveConnections(PathDirect, Web))

	resp, err := http.Get("http://" + l.Addr().String())
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, resp.Body.Close()) })

	state := <-stateC
	require.Equal(t, http.StateNew, state)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, 1, getAcceptedConnections(PathDirect, Web))
	require.Equal(t, 1, getActiveConnections(PathDirect, Web))
	require.Equal(t, 1, getAuthenticatedAcceptedConnections(PathDirect, Web))
	require.Equal(t, 1, getAuthenticatedActiveConnections(PathDirect, Web))
	require.NoError(t, resp.Body.Close())

	http.DefaultClient.CloseIdleConnections()
	state = <-stateC
	require.Equal(t, http.StateClosed, state)
	require.Equal(t, 1, getAcceptedConnections(PathDirect, Web))
	require.Equal(t, 0, getActiveConnections(PathDirect, Web))
	require.Equal(t, 1, getAuthenticatedAcceptedConnections(PathDirect, Web))
	require.Equal(t, 0, getAuthenticatedActiveConnections(PathDirect, Web))
}
