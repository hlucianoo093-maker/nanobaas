import { useCallback, useState } from "react";
import { api, jsonBody } from "./api.js";
import type { PlatformAuditEntry, PlatformOverview, PlatformSettings, PlatformUser } from "./models.js";
import {
  Badge, formatBytes, formatDate, MetricCard, PageHeading, Panel, ResourceState,
  type ErrorHandler, type NoticeHandler, useResource
} from "./ui.js";

export function PlatformOverviewView() {
  const load = useCallback(() => api.request<PlatformOverview>("/api/v1/admin/overview"), []);
  const { data, loading, error } = useResource(load);
  return (
    <>
      <PageHeading eyebrow="INSTANCE OVERVIEW" title="Platform" description="A read-only snapshot of this NanoBaaS instance." />
      <ResourceState loading={loading} error={error}>
        {data && <div className="metrics-grid">
          <MetricCard label="Total users" value={data.user_count} note={`${data.active_user_count} active`} tone="blue" />
          <MetricCard label="Projects" value={data.project_count} note="Across this instance" tone="green" />
          <MetricCard label="Active sessions" value={data.active_session_count} note="Not revoked or expired" tone="orange" />
          <MetricCard label="Stored files" value={data.file_count} note={formatBytes(data.storage_bytes)} tone="purple" />
        </div>}
      </ResourceState>
    </>
  );
}

export function PlatformUsersView({ currentUserId, onError, notify }: {
  currentUserId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [savingId, setSavingId] = useState<string>();
  const limit = 50;
  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (query) params.set("q", query);
    return api.requestPage<PlatformUser[]>(
      `/api/v1/admin/users?${params.toString()}`
    );
  }, [offset, query]);
  const { data, loading, error, reload } = useResource(load);

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOffset(0);
    setQuery(search.trim());
  }

  async function setActive(user: PlatformUser, isActive: boolean) {
    const verb = isActive ? "activate" : "deactivate";
    if (!window.confirm(`${verb[0]?.toUpperCase()}${verb.slice(1)} ${user.email}?${isActive ? "" : " Their sessions will be revoked."}`)) return;
    setSavingId(user.id);
    try {
      await api.request(`/api/v1/admin/users/${user.id}`, {
        method: "PATCH",
        body: jsonBody({ isActive })
      });
      notify(`Account ${isActive ? "activated" : "deactivated"}`);
      reload();
    } catch (failure) {
      onError(failure);
    } finally {
      setSavingId(undefined);
    }
  }

  return (
    <>
      <PageHeading eyebrow="INSTANCE ACCESS" title="All users" description="Manage account access across every project. Deactivation revokes sessions and one-time auth tokens." />
      <Panel title="User directory" description={`${data?.pagination.total ?? 0} accounts`}>
        <form className="inline-form" onSubmit={(event) => void submitSearch(event)}>
          <label className="grow">Search email<input type="search" maxLength={254} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="person@example.com" /></label>
          <button className="button button-primary">Search</button>
        </form>
        <div className="table-wrap">
          <ResourceState loading={loading} error={error} empty={data?.data.length === 0}>
            {data && <table>
              <thead><tr><th>User</th><th>Status</th><th>Projects</th><th>Sessions</th><th>Email verified</th><th>Created</th><th /></tr></thead>
              <tbody>{data.data.map((user) => (
                <tr key={user.id}>
                  <td><div className="identity-cell"><span className="avatar">{user.email.slice(0, 1).toUpperCase()}</span><span><b>{user.email}</b><small>{user.id}</small></span></div></td>
                  <td><div className="badge-list"><Badge tone={user.is_active ? "green" : "red"}>{user.is_active ? "Active" : "Inactive"}</Badge>{user.is_platform_admin_configured && <Badge tone={user.is_platform_admin ? "purple" : "orange"}>{user.is_platform_admin ? "Platform admin" : "Admin allowlisted"}</Badge>}</div></td>
                  <td>{user.project_count}</td>
                  <td>{user.active_session_count}</td>
                  <td>{user.email_verified_at ? formatDate(user.email_verified_at) : <Badge tone="orange">Unverified</Badge>}</td>
                  <td>{formatDate(user.created_at)}</td>
                  <td>{user.is_active
                    ? <button className="button button-quiet danger" disabled={savingId === user.id || user.id === currentUserId || user.is_platform_admin_configured} onClick={() => void setActive(user, false)}>Deactivate</button>
                    : <button className="button button-small" disabled={savingId === user.id} onClick={() => void setActive(user, true)}>Activate</button>}</td>
                </tr>
              ))}</tbody>
            </table>}
          </ResourceState>
        </div>
        {data && <div className="pagination-row">
          <span className="muted">{data.pagination.total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, data.pagination.total)} of {data.pagination.total}</span>
          <button className="button button-small" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
          <button className="button button-small" disabled={loading || offset + limit >= data.pagination.total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>}
      </Panel>
    </>
  );
}

export function PlatformSettingsView() {
  const load = useCallback(() => api.request<PlatformSettings>("/api/v1/admin/settings"), []);
  const { data, loading, error } = useResource(load);
  return (
    <>
      <PageHeading eyebrow="INSTANCE CONFIGURATION" title="System settings" description="Safe runtime details only. Secrets and infrastructure paths are never exposed; values are configured through the service environment." />
      <Panel title="Runtime configuration" description="These values are read-only and do not include secret material.">
        <ResourceState loading={loading} error={error}>
          {data && <dl className="detail-list">
            <div><dt>API version</dt><dd>{data.apiVersion}</dd></div>
            <div><dt>Environment</dt><dd>{data.environment}</dd></div>
            <div><dt>Node.js runtime</dt><dd>{data.nodeVersion}</dd></div>
            <div><dt>Maximum upload size</dt><dd>{formatBytes(data.maxFileBytes)}</dd></div>
            <div><dt>Email delivery</dt><dd><Badge tone={data.emailDeliveryEnabled ? "green" : "orange"}>{data.emailDeliveryEnabled ? "Configured" : "Not configured"}</Badge></dd></div>
            <div><dt>Webhook delivery</dt><dd><Badge tone={data.webhookDeliveryEnabled ? "green" : "orange"}>{data.webhookDeliveryEnabled ? "Configured" : "Not configured"}</Badge></dd></div>
            <div><dt>Configured platform administrators</dt><dd>{data.configuredPlatformAdminCount}</dd></div>
          </dl>}
        </ResourceState>
      </Panel>
    </>
  );
}

export function PlatformAuditLogsView() {
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const load = useCallback(
    () => api.requestPage<PlatformAuditEntry[]>(`/api/v1/admin/audit-logs?limit=${limit}&offset=${offset}`),
    [offset]
  );
  const { data, loading, error } = useResource(load);
  return (
    <>
      <PageHeading eyebrow="INSTANCE ACTIVITY" title="Platform audit logs" description="Authentication and platform-administration events not scoped to a project." />
      <Panel title="Audit events" description={`${data?.pagination.total ?? 0} platform events`}>
        <div className="table-wrap">
          <ResourceState loading={loading} error={error} empty={data?.data.length === 0}>
            {data && <table>
              <thead><tr><th>Action</th><th>Actor</th><th>Resource</th><th>IP address</th><th>Details</th><th>When</th></tr></thead>
              <tbody>{data.data.map((entry) => (
                <tr key={entry.id}>
                  <td><Badge>{entry.action}</Badge></td>
                  <td>{entry.actor_email ?? "Deleted account"}</td>
                  <td>{entry.resource_type}{entry.resource_id ? <small>{entry.resource_id}</small> : null}</td>
                  <td>{entry.ip_address ?? "—"}</td>
                  <td><code className="metadata-value">{entry.metadata}</code></td>
                  <td>{formatDate(entry.created_at)}</td>
                </tr>
              ))}</tbody>
            </table>}
          </ResourceState>
        </div>
        {data && <div className="pagination-row">
          <span className="muted">{data.pagination.total === 0 ? 0 : offset + 1}–{Math.min(offset + limit, data.pagination.total)} of {data.pagination.total}</span>
          <button className="button button-small" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</button>
          <button className="button button-small" disabled={loading || offset + limit >= data.pagination.total} onClick={() => setOffset(offset + limit)}>Next</button>
        </div>}
      </Panel>
    </>
  );
}
