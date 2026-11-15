import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "./api.js";
import type { AuditEntry, Project, StoredFile, Webhook } from "./models.js";
import {
  Badge, formatBytes, formatDate, InlineError, PageHeading, Panel, ResourceState,
  type ErrorHandler, type NoticeHandler, useResource
} from "./ui.js";

export function StorageView({ projectId, onError, notify }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [uploading, setUploading] = useState(false);
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const response = await api.request<StoredFile[]>(
      `/api/v1/projects/${projectId}/storage/files?limit=100&offset=${offset}`
    );
    return response;
  }, [projectId, offset]);
  const { data, loading, error, reload } = useResource(load);

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("file") as HTMLInputElement | null;
    const selected = input?.files?.[0];
    if (!selected) return;
    const body = new FormData();
    body.append("file", selected);
    setUploading(true);
    try {
      await api.request(`/api/v1/projects/${projectId}/storage/files`, { method: "POST", body });
      form.reset();
      notify("File uploaded");
      reload();
    } catch (error) {
      onError(error);
    } finally {
      setUploading(false);
    }
  }

  async function download(file: StoredFile) {
    try {
      const content = await api.download(`/api/v1/projects/${projectId}/storage/files/${file.id}/content`);
      const url = URL.createObjectURL(content);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      onError(error);
    }
  }

  async function remove(file: StoredFile) {
    if (!window.confirm(`Permanently delete "${file.name}"?`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}/storage/files/${file.id}`, { method: "DELETE" });
      notify("File deleted");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  const totalBytes = data?.reduce((total, file) => total + file.sizeBytes, 0) ?? 0;
  return (
    <>
      <PageHeading eyebrow="OBJECT STORAGE" title="Storage" description="Upload and manage project-scoped files." />
      <Panel title="Upload a file" description="PNG, JPEG, GIF, WebP, or PDF. The configured file-size limit applies.">
        <form className="upload-form" onSubmit={(event) => void upload(event)}>
          <label className="file-picker">Choose file<input name="file" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" required /></label>
          <button className="button button-primary" disabled={uploading}>{uploading ? "Uploading…" : "Upload file"}</button>
        </form>
      </Panel>
      <Panel title="Project files" description={`${data?.length ?? 0} files shown · ${formatBytes(totalBytes)} in this page`}>
        <ResourceState loading={loading} error={error} empty={data?.length === 0}>
          {data && <div className="table-wrap"><table>
            <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th /></tr></thead>
            <tbody>{data.map((file) => (
              <tr key={file.id}>
                <td><div className="file-cell"><span className="file-type-mark">{file.mimeType === "application/pdf" ? "PDF" : "IMG"}</span><span><b>{file.name}</b><small>{file.id}</small></span></div></td>
                <td><Badge>{file.mimeType}</Badge></td>
                <td>{formatBytes(file.sizeBytes)}</td>
                <td>{formatDate(file.createdAt)}</td>
                <td><div className="button-row"><button className="button button-small" onClick={() => void download(file)}>Download</button><button className="button button-small button-quiet danger" onClick={() => void remove(file)}>Delete</button></div></td>
              </tr>
            ))}</tbody>
          </table></div>}
        </ResourceState>
        <div className="pagination-row"><button className="button button-small" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - 100))}>Previous</button><span className="muted">Offset {offset}</span><button className="button button-small" disabled={loading || (data?.length ?? 0) < 100} onClick={() => setOffset((value) => value + 100)}>Next</button></div>
      </Panel>
    </>
  );
}

const webhookEventOptions = ["data.created", "data.updated", "data.deleted", "file.uploaded", "file.deleted"];

export function WebhooksView({ projectId, onError, notify }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["data.created"]);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => api.request<Webhook[]>(`/api/v1/projects/${projectId}/webhooks`), [projectId]);
  const { data, loading, error, reload } = useResource(load);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const hook = await api.request<{ secret: string }>(`/api/v1/projects/${projectId}/webhooks`, {
        method: "POST",
        body: jsonBody({ url, events })
      });
      setSecret(hook.secret);
      setUrl("");
      notify("Webhook created — copy the signing secret now");
      reload();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(hook: Webhook) {
    try {
      await api.request(`/api/v1/projects/${projectId}/webhooks/${hook.id}`, {
        method: "PATCH",
        body: jsonBody({ isActive: !hook.isActive })
      });
      notify(hook.isActive ? "Webhook disabled; queued deliveries were cancelled" : "Webhook enabled");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  async function rotate(hook: Webhook) {
    if (!window.confirm(`Rotate the signing secret for ${hook.url}? Update the receiver immediately.`)) return;
    try {
      const result = await api.request<{ secret: string }>(`/api/v1/projects/${projectId}/webhooks/${hook.id}/rotate-secret`, { method: "POST" });
      setSecret(result.secret);
      notify("Webhook secret rotated — copy the new secret now");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  async function remove(hook: Webhook) {
    if (!window.confirm(`Delete this webhook and its delivery history?`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}/webhooks/${hook.id}`, { method: "DELETE" });
      notify("Webhook deleted");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="EVENT DELIVERY" title="Webhooks" description="Send signed project events to HTTPS endpoints." />
      {secret && <div className="secret-banner"><div><b>Copy your signing secret</b><p>This value is shown once. Update your receiver before dismissing.</p><code>{secret}</code></div><button className="button button-primary" onClick={() => void navigator.clipboard.writeText(secret).then(() => notify("Copied to clipboard")).catch(onError)}>Copy secret</button><button className="icon-button" aria-label="Dismiss secret" onClick={() => setSecret("")}>×</button></div>}
      <div className="two-column-layout">
        <Panel title="Add a webhook" description="HTTPS on port 443. Query strings and URL credentials are not allowed.">
          <form className="form-stack" onSubmit={(event) => void create(event)}>
            <label>Endpoint URL<input type="url" required maxLength={2048} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://api.example.com/events" /></label>
            <fieldset className="check-list"><legend>Subscribe to events</legend>{webhookEventOptions.map((item) => (
              <label className="check-row" key={item}><input type="checkbox" checked={events.includes(item)} onChange={(event) => setEvents((current) => event.target.checked ? [...current, item] : current.filter((value) => value !== item))} /><span>{item}</span></label>
            ))}</fieldset>
            <button className="button button-primary" disabled={saving || events.length === 0}>{saving ? "Creating…" : "Create webhook"}</button>
          </form>
        </Panel>
        <Panel title="Configured endpoints" description={`${data?.length ?? 0} endpoints`}>
          <ResourceState loading={loading} error={error} empty={data?.length === 0}>
            {data && <div className="stack-list">{data.map((hook) => (
              <article className="list-item" key={hook.id}>
                <div className="list-item-top"><div><b className="endpoint-url">{hook.url}</b><small>Created {formatDate(hook.createdAt)}</small></div><Badge tone={hook.isActive ? "green" : "neutral"}>{hook.isActive ? "Active" : "Paused"}</Badge></div>
                <div className="badge-list">{hook.events.map((item) => <Badge key={item}>{item}</Badge>)}</div>
                <div className="button-row item-actions">
                  <button className="button button-small" onClick={() => void toggle(hook)}>{hook.isActive ? "Pause" : "Resume"}</button>
                  <button className="button button-small" onClick={() => void rotate(hook)}>Rotate secret</button>
                  <button className="button button-small button-quiet danger" onClick={() => void remove(hook)}>Delete</button>
                </div>
              </article>
            ))}</div>}
          </ResourceState>
        </Panel>
      </div>
    </>
  );
}

export function AuditLogsView({ projectId }: { projectId: string }) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(async () => {
    const response = await api.request<AuditEntry[]>(
      `/api/v1/projects/${projectId}/audit-logs?limit=50&offset=${offset}`
    );
    return response;
  }, [projectId, offset]);
  const { data, loading, error } = useResource(load);
  return (
    <>
      <PageHeading eyebrow="SECURITY & ACTIVITY" title="Audit logs" description="Review project management and security events." />
      <Panel title="Recent events" description="Audit entries are retained with the project database.">
        <ResourceState loading={loading} error={error} empty={data?.length === 0}>
          {data && <div className="table-wrap"><table>
            <thead><tr><th>Event</th><th>Actor</th><th>Resource</th><th>Metadata</th><th>Time</th></tr></thead>
            <tbody>{data.map((entry) => (
              <tr key={entry.id}>
                <td><Badge tone={entry.action.includes("revok") || entry.action.includes("deleted") ? "orange" : "blue"}>{entry.action}</Badge></td>
                <td>{entry.actor_email ?? "System"}<small>{entry.ip_address ?? "—"}</small></td>
                <td><b>{entry.resource_type}</b><small>{entry.resource_id ?? "—"}</small></td>
                <td><code className="metadata-value">{entry.metadata}</code></td>
                <td>{formatDate(entry.created_at)}</td>
              </tr>
            ))}</tbody>
          </table></div>}
        </ResourceState>
        <div className="pagination-row"><button className="button button-small" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Previous</button><span className="muted">Rows {offset + 1}–{offset + (data?.length ?? 0)}</span><button className="button button-small" disabled={loading || (data?.length ?? 0) < 50} onClick={() => setOffset((value) => value + 50)}>Next</button></div>
      </Panel>
    </>
  );
}

export function SettingsView({ projectId, onError, notify, onProjectDeleted, onProjectUpdated }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
  onProjectDeleted: () => void;
  onProjectUpdated: () => void;
}) {
  const [name, setName] = useState("");
  const [settings, setSettings] = useState("{}");
  const [validationError, setValidationError] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(() => api.request<Project>(`/api/v1/projects/${projectId}`), [projectId]);
  const { data, loading, error, reload } = useResource(load);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    try {
      setSettings(JSON.stringify(JSON.parse(data.settings) as unknown, null, 2));
    } catch {
      setSettings(data.settings);
    }
  }, [data]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidationError("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(settings) as unknown;
    } catch {
      setValidationError("Settings must be valid JSON.");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setValidationError("Settings must be a JSON object.");
      return;
    }
    setSaving(true);
    try {
      await api.request(`/api/v1/projects/${projectId}`, {
        method: "PATCH",
        body: jsonBody({ name, settings: parsed })
      });
      notify("Project settings saved");
      onProjectUpdated();
      reload();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function deleteProject() {
    if (!data || !window.confirm(`Permanently delete "${data.name}" and all of its data, keys, files, and webhooks?`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}`, { method: "DELETE" });
      notify("Project and its resources deleted");
      onProjectDeleted();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="CONFIGURATION" title="Project settings" description="Update project identity and JSON configuration." />
      <Panel title="General settings" description="Changes apply to this project only.">
        <ResourceState loading={loading} error={error}>
          {data && <form className="settings-form" onSubmit={(event) => void save(event)}>
            <label>Project name<input required minLength={1} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <div className="settings-static"><span>Project slug</span><code>{data.slug}</code><span>Project ID</span><code>{data.id}</code></div>
            <label>Configuration JSON<textarea className="code-editor" rows={12} spellCheck={false} value={settings} onChange={(event) => setSettings(event.target.value)} /></label>
            {validationError && <InlineError>{validationError}</InlineError>}
            <div><button className="button button-primary" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button></div>
          </form>}
        </ResourceState>
      </Panel>
      {data?.member_role === "owner" && <Panel title="Delete project" description="This action permanently removes every resource in the project.">
        <button className="button button-quiet danger" disabled={loading} onClick={() => void deleteProject()}>Delete this project</button>
      </Panel>}
    </>
  );
}
