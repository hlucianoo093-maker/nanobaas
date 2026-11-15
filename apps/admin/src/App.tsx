import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, jsonBody } from "./api.js";
import type { Project } from "./models.js";
import {
  ApiKeysView, MembersView, OverviewView, ProjectsView, RolesView
} from "./project-views.js";
import {
  AuditLogsView, SettingsView, StorageView, WebhooksView
} from "./resource-views.js";
import {
  PlatformAuditLogsView, PlatformOverviewView, PlatformSettingsView, PlatformUsersView
} from "./platform-views.js";
import { errorMessage } from "./ui.js";

type UserIdentity = { id: string; email: string; isPlatformAdmin: boolean };
type SectionId = "overview" | "projects" | "users" | "api-keys" | "roles" | "storage" | "webhooks" | "audit-logs" | "settings"
  | "platform-overview" | "platform-users" | "platform-settings" | "platform-audit";

const navigation: { id: SectionId; title: string; icon: string; group: "workspace" | "management" | "platform" }[] = [
  { id: "overview", title: "Overview", icon: "OV", group: "workspace" },
  { id: "projects", title: "Projects", icon: "PR", group: "workspace" },
  { id: "users", title: "Users", icon: "US", group: "management" },
  { id: "api-keys", title: "API keys", icon: "AK", group: "management" },
  { id: "roles", title: "Roles & permissions", icon: "RB", group: "management" },
  { id: "storage", title: "Storage", icon: "ST", group: "management" },
  { id: "webhooks", title: "Webhooks", icon: "WH", group: "management" },
  { id: "audit-logs", title: "Audit logs", icon: "AU", group: "management" },
  { id: "settings", title: "Project settings", icon: "SE", group: "management" },
  { id: "platform-overview", title: "Instance overview", icon: "IO", group: "platform" },
  { id: "platform-users", title: "All users", icon: "AU", group: "platform" },
  { id: "platform-settings", title: "System settings", icon: "SS", group: "platform" },
  { id: "platform-audit", title: "Platform audit", icon: "PA", group: "platform" }
];

export function App() {
  const [user, setUser] = useState<UserIdentity>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [section, setSection] = useState<SectionId>("overview");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [globalError, setGlobalError] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<number | undefined>(undefined);
  const authenticated = Boolean(user);
  const visibleNavigation = user?.isPlatformAdmin ? navigation : navigation.filter((item) => item.group !== "platform");

  const reportError = useCallback((error: unknown) => setGlobalError(errorMessage(error)), []);
  const notify = useCallback((message: string) => {
    setGlobalError("");
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 4000);
  }, []);

  useEffect(() => {
    api.onSessionExpired(() => {
      setUser(undefined);
      setProjects([]);
      setSelectedProjectId("");
      setGlobalError("Your session expired. Sign in again to continue.");
    });
    return () => {
      api.onSessionExpired(() => undefined);
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const results = await api.request<Project[]>("/api/v1/projects");
      setProjects(results);
      setSelectedProjectId((current) => results.some((project) => project.id === current) ? current : results[0]?.id ?? "");
    } catch (error) {
      reportError(error);
    } finally {
      setLoadingProjects(false);
    }
  }, [reportError]);

  useEffect(() => {
    if (authenticated) void loadProjects();
  }, [authenticated, loadProjects]);

  async function signIn(email: string, password: string) {
    setGlobalError("");
    try {
      const session = await api.request<{
        user: UserIdentity;
        accessToken: string;
        refreshToken: string;
      }>("/api/v1/auth/login", { method: "POST", body: jsonBody({ email, password }) });
      api.setSession(session.accessToken, session.refreshToken);
      setUser(session.user);
      setSection("overview");
      notify("Welcome to NanoBaaS");
    } catch (error) {
      reportError(error);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } catch (error) {
      setGlobalError(`Could not revoke the server session: ${errorMessage(error)}`);
    } finally {
      api.clearSession();
      setUser(undefined);
      setProjects([]);
      setSelectedProjectId("");
      setNotice("");
    }
  }

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId),
    [projects, selectedProjectId]
  );
  const currentSection = visibleNavigation.find((item) => item.id === section) ?? navigation[0]!;

  if (!authenticated) {
    return <LoginView error={globalError} onSubmit={signIn} />;
  }

  const projectId = selectedProject?.id;
  const componentProps = { projectId: projectId ?? "", onError: reportError, notify };
  let page: React.ReactNode;
  switch (section) {
    case "overview":
      page = projectId ? <OverviewView projectId={projectId} /> : <ProjectsView projects={projects} selectedId={selectedProjectId} onSelect={setSelectedProjectId} onCreated={() => void loadProjects()} onComplete={() => setSection("overview")} onError={reportError} notify={notify} />;
      break;
    case "projects":
      page = <ProjectsView projects={projects} selectedId={selectedProjectId} onSelect={setSelectedProjectId} onCreated={() => void loadProjects()} onComplete={() => setSection("overview")} onError={reportError} notify={notify} />;
      break;
    case "users":
      page = projectId ? <MembersView {...componentProps} /> : <SelectProjectNotice />;
      break;
    case "api-keys":
      page = projectId ? <ApiKeysView {...componentProps} /> : <SelectProjectNotice />;
      break;
    case "roles":
      page = projectId ? <RolesView {...componentProps} /> : <SelectProjectNotice />;
      break;
    case "storage":
      page = projectId ? <StorageView {...componentProps} /> : <SelectProjectNotice />;
      break;
    case "webhooks":
      page = projectId ? <WebhooksView {...componentProps} /> : <SelectProjectNotice />;
      break;
    case "audit-logs":
      page = projectId ? <AuditLogsView projectId={projectId} /> : <SelectProjectNotice />;
      break;
    case "settings":
      page = projectId ? <SettingsView {...componentProps} onProjectDeleted={() => { setSection("projects"); void loadProjects(); }} onProjectUpdated={() => void loadProjects()} /> : <SelectProjectNotice />;
      break;
    case "platform-overview":
      page = <PlatformOverviewView />;
      break;
    case "platform-users":
      page = <PlatformUsersView currentUserId={user?.id ?? ""} onError={reportError} notify={notify} />;
      break;
    case "platform-settings":
      page = <PlatformSettingsView />;
      break;
    case "platform-audit":
      page = <PlatformAuditLogsView />;
      break;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><span className="brand-symbol">n</span><span>Nano<span>BaaS</span><small>CONTROL PLANE</small></span></div>
        <div className="sidebar-label">WORKSPACE</div>
        <div className="sidebar-project">
          <span className="project-mark">{selectedProject?.name.slice(0, 1).toUpperCase() ?? "N"}</span>
          <select aria-label="Select project" value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)} disabled={projects.length === 0}>
            {projects.length === 0 ? <option value="">No projects</option> : projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
          </select>
          <span className="select-chevron">⌄</span>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {visibleNavigation.map((item, index) => (
            <div key={item.id}>
              {(index === 0 || item.group !== visibleNavigation[index - 1]?.group) && <p className="nav-section-label">{item.group === "workspace" ? "WORKSPACE" : item.group === "management" ? "MANAGE" : "PLATFORM ADMIN"}</p>}
              <button className={`nav-item ${section === item.id ? "nav-item-active" : ""}`} onClick={() => setSection(item.id)}>
                <span className="nav-icon">{item.icon}</span><span>{item.title}</span>
                {section === item.id && <span className="nav-active-mark" />}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="status-indicator"><span />API connected</div>
          <a href="/documentation" target="_blank" rel="noreferrer">API documentation <span>↗</span></a>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{currentSection.title}</strong></div>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Refresh projects" title="Refresh projects" onClick={() => void loadProjects()} disabled={loadingProjects}>↻</button>
            <div className="account-menu"><span className="avatar avatar-user">{user?.email.slice(0, 1).toUpperCase()}</span><span className="account-copy"><b>{user?.email}</b><small>{user?.isPlatformAdmin ? "Platform administrator" : "NanoBaaS account"}</small></span><button className="button button-quiet" onClick={() => void signOut()}>Sign out</button></div>
          </div>
        </header>
        <div className="content-area">
          {globalError && <div className="global-alert" role="alert"><span>{globalError}</span><button aria-label="Dismiss error" onClick={() => setGlobalError("")}>×</button></div>}
          {notice && <div className="toast-message" role="status">{notice}</div>}
          {loadingProjects && projects.length === 0 ? <div className="state-box">Loading your projects…</div> : page}
        </div>
      </main>
    </div>
  );
}

function LoginView({ error, onSubmit }: { error: string; onSubmit: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-visual">
        <div className="login-grid" />
        <div className="login-brand"><span className="brand-symbol">n</span><span>Nano<span>BaaS</span></span></div>
        <div className="login-copy"><p className="eyebrow">YOUR BACKEND, UNDER CONTROL</p><h1>Everything your apps need.<br /><em>Nothing they don't.</em></h1><p>Manage projects, access, storage, and event delivery from one lightweight control plane.</p></div>
        <div className="login-visual-foot"><span>SQLite · Fastify · Built for small infrastructure</span><span>01 — SECURE BY DESIGN</span></div>
      </div>
      <div className="login-form-side">
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <div className="login-form-heading"><span className="eyebrow">ADMINISTRATION</span><h2>Welcome back</h2><p>Sign in with your NanoBaaS account to continue.</p></div>
          {error && <div className="global-alert" role="alert">{error}</div>}
          <label>Email address<input type="email" autoComplete="username" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" /></label>
          <label>Password<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" /></label>
          <button className="button button-primary login-submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}<span>→</span></button>
          <p className="login-security"><span>▣</span> Your credentials are sent only to this NanoBaaS API.</p>
        </form>
        <footer className="login-footer">NanoBaaS · Lightweight infrastructure for independent teams</footer>
      </div>
    </div>
  );
}

function SelectProjectNotice() {
  return <div className="select-project-notice"><span>PR</span><h2>Select a project</h2><p>Choose an existing project from the workspace menu or create one in Projects.</p></div>;
}
