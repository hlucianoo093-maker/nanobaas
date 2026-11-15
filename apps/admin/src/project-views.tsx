import { useCallback, useState } from "react";
import { api, jsonBody } from "./api.js";
import type { ApiKey, Member, Permission, Project, ProjectOverview, ProjectRole } from "./models.js";
import {
  Badge, formatBytes, formatDate, MetricCard, PageHeading, Panel, ResourceState,
  type ErrorHandler, type NoticeHandler, useResource
} from "./ui.js";

export function OverviewView({ projectId }: { projectId: string }) {
  const load = useCallback(() => api.request<ProjectOverview>(`/api/v1/projects/${projectId}/overview`), [projectId]);
  const { data, loading, error } = useResource(load);
  return (
    <>
      <PageHeading eyebrow="PROJECT OVERVIEW" title={data?.name ?? "Overview"} description="A live snapshot of this project's resources and activity footprint." />
      <ResourceState loading={loading} error={error}>
        {data && (
          <>
            <div className="metrics-grid">
              <MetricCard label="Collection records" value={data.record_count} note="Across all collections" tone="blue" />
              <MetricCard label="Project members" value={data.member_count} note="People with project access" tone="green" />
              <MetricCard label="Active API keys" value={data.active_api_key_count} note="Valid and not expired" tone="orange" />
              <MetricCard label="Storage used" value={formatBytes(data.storage_bytes)} note={`${data.file_count} stored files`} tone="purple" />
            </div>
            <div className="overview-lower">
              <Panel title="Project profile" description="Workspace identity and configuration">
                <dl className="detail-list">
                  <div><dt>Project name</dt><dd>{data.name}</dd></div>
                  <div><dt>Slug</dt><dd><code>{data.slug}</code></dd></div>
                  <div><dt>Project ID</dt><dd><code>{data.id}</code></dd></div>
                  <div><dt>Created</dt><dd>{formatDate(data.created_at)}</dd></div>
                </dl>
              </Panel>
              <Panel title="Platform services" description="Resources attached to this project">
                <div className="service-list">
                  <div><span className="service-icon">RB</span><span><b>Custom roles</b><small>Reusable permission groups</small></span><strong>{data.role_count}</strong></div>
                  <div><span className="service-icon">WH</span><span><b>Active webhooks</b><small>Event delivery destinations</small></span><strong>{data.active_webhook_count}</strong></div>
                  <div><span className="service-icon">DB</span><span><b>Data records</b><small>Project-scoped JSON data</small></span><strong>{data.record_count}</strong></div>
                </div>
              </Panel>
            </div>
          </>
        )}
      </ResourceState>
    </>
  );
}

export function ProjectsView({ projects, selectedId, onSelect, onCreated, onComplete, onError, notify }: {
  projects: Project[];
  selectedId: string;
  onSelect: (id: string) => void;
  onCreated: () => void;
  onComplete: () => void;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [createdProject, setCreatedProject] = useState<Project>();
  const [keyName, setKeyName] = useState("Initial app key");
  const [permissions, setPermissions] = useState<string[]>(["data:read"]);
  const [secret, setSecret] = useState("");

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const project = await api.request<Project>("/api/v1/projects", {
        method: "POST",
        body: jsonBody({ name, slug })
      });
      setCreatedProject(project);
      onSelect(project.id);
      onCreated();
      setStep(2);
      notify("Project created");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function createApiKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!createdProject) return;
    setSaving(true);
    try {
      const result = await api.request<{ key: string }>(`/api/v1/projects/${createdProject.id}/api-keys`, {
        method: "POST",
        body: jsonBody({ name: keyName, permissions })
      });
      setSecret(result.key);
      setStep(3);
      notify("API key created — copy it now");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      notify("Copied API key to clipboard");
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="WORKSPACES" title="Projects" description="Set up an isolated backend for each application." />
      <div className="two-column-layout">
        <Panel title="Your projects" description={`${projects.length} project${projects.length === 1 ? "" : "s"} available`}>
          {projects.length === 0 ? <div className="state-box">Create your first project to get started.</div> : (
            <div className="project-list">
              {projects.map((project) => (
                <button
                  type="button"
                  className={`project-card ${selectedId === project.id ? "project-card-selected" : ""}`}
                  onClick={() => onSelect(project.id)}
                  key={project.id}
                >
                  <span className="project-mark">{project.name.slice(0, 1).toUpperCase()}</span>
                  <span className="project-card-copy"><b>{project.name}</b><small>{project.slug} · {project.member_role}</small></span>
                  <span className="project-arrow">↗</span>
                </button>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Project setup" description="Follow these steps to prepare a project for your application.">
          <ol className="setup-steps" aria-label="Project setup progress">
            <li className={step >= 1 ? "setup-step-active" : ""}><span>1</span>Project</li>
            <li className={step >= 2 ? "setup-step-active" : ""}><span>2</span>API access</li>
            <li className={step >= 3 ? "setup-step-active" : ""}><span>3</span>Finish</li>
          </ol>
          {step === 1 && (
            <form className="form-stack" onSubmit={(event) => void createProject(event)}>
              <p className="wizard-copy">Create a project to isolate this application's data, users, and settings.</p>
              <label>Project name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Customer Portal" /></label>
              <label>Project slug<input required maxLength={63} pattern={"[a-z0-9](?:[a-z0-9]|[a-z0-9][a-z0-9\\-]{0,61}[a-z0-9])?"} value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} placeholder="customer-portal" /></label>
              <p className="field-note">Use lowercase letters, numbers, and hyphens.</p>
              <button className="button button-primary" disabled={saving}>{saving ? "Creating…" : "Create project and continue"}</button>
            </form>
          )}
          {step === 2 && createdProject && (
            <form className="form-stack" onSubmit={(event) => void createApiKey(event)}>
              <p className="wizard-copy"><b>{createdProject.name}</b> is ready. Create a scoped API key for your application, or skip this and add one later.</p>
              <label>Key name<input required maxLength={100} value={keyName} onChange={(event) => setKeyName(event.target.value)} /></label>
              <fieldset className="check-list">
                <legend>Permissions</legend>
                {["data:read", "data:write", "files:read", "files:write"].map((permission) => (
                  <label className="check-row" key={permission}>
                    <input type="checkbox" checked={permissions.includes(permission)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, permission] : current.filter((value) => value !== permission))} />
                    <span>{permission}</span>
                  </label>
                ))}
              </fieldset>
              <div className="button-row">
                <button className="button button-primary" disabled={saving || permissions.length === 0}>{saving ? "Creating…" : "Create API key"}</button>
                <button className="button" type="button" onClick={() => setStep(3)} disabled={saving}>Skip for now</button>
              </div>
            </form>
          )}
          {step === 3 && createdProject && (
            <div className="form-stack">
              <div className="wizard-complete"><span>✓</span><div><b>{createdProject.name} is ready</b><p>Project ID: <code>{createdProject.id}</code></p></div></div>
              {secret ? (
                <div className="secret-banner wizard-secret">
                  <div><b>Copy your API key now</b><p>It is shown only once. If lost, revoke it and create a replacement.</p><code>{secret}</code></div>
                  <button className="button button-primary" type="button" onClick={() => void copySecret()}>Copy key</button>
                </div>
              ) : (
                <p className="wizard-copy">No API key was created. You can create one later from the API keys section.</p>
              )}
              <button className="button button-primary" type="button" onClick={onComplete}>Open project overview</button>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

export function MembersView({ projectId, onError, notify }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const [members, roles] = await Promise.all([
      api.request<Member[]>(`/api/v1/projects/${projectId}/members`),
      api.request<ProjectRole[]>(`/api/v1/projects/${projectId}/roles`)
    ]);
    return { members, roles };
  }, [projectId]);
  const { data, loading, error, reload } = useResource(load);

  async function addMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.request(`/api/v1/projects/${projectId}/members`, { method: "POST", body: jsonBody({ email }) });
      setEmail("");
      notify("Member added");
      reload();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function removeMember(member: Member) {
    if (!window.confirm(`Remove ${member.email} from this project?`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}/members/${member.id}`, { method: "DELETE" });
      notify("Member removed");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  async function saveRoles(member: Member, selected: string[]) {
    try {
      await api.request(`/api/v1/projects/${projectId}/members/${member.id}/roles`, {
        method: "PUT",
        body: jsonBody({ roleIds: selected })
      });
      notify(`Roles updated for ${member.email}`);
      reload();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="ACCESS CONTROL" title="Users & members" description="Manage the people and role assignments in this project." />
      <Panel title="Add a project member" description="The user must already have a NanoBaaS account.">
        <form className="inline-form" onSubmit={(event) => void addMember(event)}>
          <label className="grow">Account email<input type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="person@example.com" /></label>
          <button className="button button-primary" disabled={saving}>{saving ? "Adding…" : "Add member"}</button>
        </form>
      </Panel>
      <Panel title="Project members" description="Access is scoped to this project.">
        <ResourceState loading={loading} error={error} empty={data?.members.length === 0}>
          {data && <div className="table-wrap"><table>
            <thead><tr><th>Member</th><th>Project role</th><th>Custom roles</th><th>Added</th><th /></tr></thead>
            <tbody>{data.members.map((member) => (
              <tr key={member.id}>
                <td><div className="identity-cell"><span className="avatar">{member.email.slice(0, 1).toUpperCase()}</span><span><b>{member.email}</b><small>{member.id}</small></span></div></td>
                <td><Badge tone={member.role === "owner" ? "purple" : "neutral"}>{member.role}</Badge></td>
                <td>{member.role === "owner" ? <span className="muted">All permissions</span> : (
                  <div className="role-assignment">
                    <select multiple size={Math.min(3, Math.max(2, data.roles.length))} defaultValue={member.assignedRoles.map((role) => role.id)} aria-label={`Roles for ${member.email}`}>
                      {data.roles.map((role) => <option value={role.id} key={role.id}>{role.name}</option>)}
                    </select>
                    <button className="button button-small" type="button" onClick={(event) => {
                      const select = event.currentTarget.parentElement?.querySelector("select");
                      if (select) void saveRoles(member, Array.from(select.selectedOptions, (option) => option.value));
                    }}>Save roles</button>
                  </div>
                )}</td>
                <td>{formatDate(member.created_at)}</td>
                <td>{member.role === "member" && <button className="button button-quiet danger" onClick={() => void removeMember(member)}>Remove</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>}
        </ResourceState>
      </Panel>
    </>
  );
}

export function ApiKeysView({ projectId, onError, notify }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const permissionOptions = ["data:read", "data:write", "files:read", "files:write"];
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<string[]>(["data:read"]);
  const [secret, setSecret] = useState("");
  const load = useCallback(() => api.request<ApiKey[]>(`/api/v1/projects/${projectId}/api-keys`), [projectId]);
  const { data, loading, error, reload } = useResource(load);

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const key = await api.request<{ key: string }>("/api/v1/projects/" + projectId + "/api-keys", {
        method: "POST",
        body: jsonBody({ name, permissions })
      });
      setSecret(key.key);
      setName("");
      notify("API key created — copy it now");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  async function revoke(key: ApiKey) {
    if (!window.confirm(`Revoke API key "${key.name}"?`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}/api-keys/${key.id}`, { method: "DELETE" });
      notify("API key revoked");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="DEVELOPER ACCESS" title="API keys" description="Create and revoke scoped credentials for server-to-server access." />
      {secret && <div className="secret-banner"><div><b>Copy your new API key</b><p>This value is shown once and cannot be recovered.</p><code>{secret}</code></div><button className="button button-primary" onClick={() => void navigator.clipboard.writeText(secret).then(() => notify("Copied to clipboard")).catch(onError)}>Copy key</button><button className="icon-button" aria-label="Dismiss key" onClick={() => setSecret("")}>×</button></div>}
      <div className="two-column-layout">
        <Panel title="Issue a new key" description="Grant only the permissions the integration needs.">
          <form className="form-stack" onSubmit={(event) => void createKey(event)}>
            <label>Key name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Production server" /></label>
            <fieldset className="check-list"><legend>Permissions</legend>{permissionOptions.map((permission) => (
              <label className="check-row" key={permission}><input type="checkbox" checked={permissions.includes(permission)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, permission] : current.filter((value) => value !== permission))} /><span>{permission}</span></label>
            ))}</fieldset>
            <button className="button button-primary" disabled={permissions.length === 0}>Generate API key</button>
          </form>
        </Panel>
        <Panel title="Issued keys" description="Raw credentials are never included in this list.">
          <ResourceState loading={loading} error={error} empty={data?.length === 0}>
            {data && <div className="table-wrap"><table>
              <thead><tr><th>Name</th><th>Scopes</th><th>Last used</th><th>Status</th><th /></tr></thead>
              <tbody>{data.map((key) => (
                <tr key={key.id}>
                  <td><b>{key.name}</b><small><code>{key.key_prefix.slice(0, 18)}…</code></small></td>
                  <td><div className="badge-list">{(JSON.parse(key.permissions) as string[]).map((permission) => <Badge key={permission}>{permission}</Badge>)}</div></td>
                  <td>{formatDate(key.last_used_at)}</td>
                  <td><Badge tone={key.revoked_at ? "red" : "green"}>{key.revoked_at ? "Revoked" : "Active"}</Badge></td>
                  <td>{!key.revoked_at && <button className="button button-quiet danger" onClick={() => void revoke(key)}>Revoke</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>}
          </ResourceState>
        </Panel>
      </div>
    </>
  );
}

export function RolesView({ projectId, onError, notify }: {
  projectId: string;
  onError: ErrorHandler;
  notify: NoticeHandler;
}) {
  const [editing, setEditing] = useState<ProjectRole>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const [roles, permissions] = await Promise.all([
      api.request<ProjectRole[]>(`/api/v1/projects/${projectId}/roles`),
      api.request<Permission[]>(`/api/v1/projects/${projectId}/permissions`)
    ]);
    return { roles, permissions };
  }, [projectId]);
  const { data, loading, error, reload } = useResource(load);

  function startEditing(role: ProjectRole) {
    setEditing(role);
    setName(role.name);
    setDescription(role.description);
    setSelectedPermissions(role.permissions);
  }

  function resetForm() {
    setEditing(undefined);
    setName("");
    setDescription("");
    setSelectedPermissions([]);
  }

  async function saveRole(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = { name, description, permissions: selectedPermissions };
      if (editing) {
        await api.request(`/api/v1/projects/${projectId}/roles/${editing.id}`, { method: "PATCH", body: jsonBody(payload) });
        notify("Role updated");
      } else {
        await api.request(`/api/v1/projects/${projectId}/roles`, { method: "POST", body: jsonBody(payload) });
        notify("Role created");
      }
      resetForm();
      reload();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  }

  async function removeRole(role: ProjectRole) {
    if (!window.confirm(`Delete the "${role.name}" role? Assigned members will lose it.`)) return;
    try {
      await api.request(`/api/v1/projects/${projectId}/roles/${role.id}`, { method: "DELETE" });
      notify("Role deleted");
      reload();
    } catch (error) {
      onError(error);
    }
  }

  return (
    <>
      <PageHeading eyebrow="ACCESS CONTROL" title="Roles & permissions" description="Define reusable project-level capabilities and assign them to members." />
      <div className="two-column-layout">
        <Panel title={editing ? `Edit ${editing.name}` : "Create a role"} description="Owners retain full access; custom roles grant only selected permissions.">
          <form className="form-stack" onSubmit={(event) => void saveRole(event)}>
            <label>Role name<input required minLength={2} maxLength={50} pattern={"[a-z][a-z0-9_\\-]*"} value={name} onChange={(event) => setName(event.target.value)} placeholder="content-editor" /></label>
            <label>Description<input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Can update content records" /></label>
            <fieldset className="check-list"><legend>Permissions</legend>
              {data?.permissions.map((permission) => (
                <label className="check-row permission-row" key={permission.name}>
                  <input type="checkbox" checked={selectedPermissions.includes(permission.name)} onChange={(event) => setSelectedPermissions((current) => event.target.checked ? [...current, permission.name] : current.filter((value) => value !== permission.name))} />
                  <span><b>{permission.name}</b><small>{permission.description}</small></span>
                </label>
              ))}
            </fieldset>
            <div className="button-row"><button className="button button-primary" disabled={saving || loading}>{saving ? "Saving…" : editing ? "Save changes" : "Create role"}</button>{editing && <button type="button" className="button" onClick={resetForm}>Cancel</button>}</div>
          </form>
        </Panel>
        <Panel title="Project roles" description={`${data?.roles.length ?? 0} custom role${data?.roles.length === 1 ? "" : "s"}`}>
          <ResourceState loading={loading} error={error} empty={data?.roles.length === 0}>
            {data && <div className="stack-list">{data.roles.map((role) => (
              <article className="list-item" key={role.id}>
                <div className="list-item-top"><div><b>{role.name}</b><p className="muted">{role.description || "No description"}</p></div><div className="button-row"><button className="button button-small" onClick={() => startEditing(role)}>Edit</button><button className="button button-small button-quiet danger" onClick={() => void removeRole(role)}>Delete</button></div></div>
                <div className="badge-list">{role.permissions.length ? role.permissions.map((permission) => <Badge key={permission}>{permission}</Badge>) : <span className="muted">No permissions assigned</span>}</div>
              </article>
            ))}</div>}
          </ResourceState>
        </Panel>
      </div>
    </>
  );
}
