CREATE UNIQUE INDEX roles_id_project_idx ON roles(id, project_id);

CREATE TABLE user_roles_new (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, role_id),
  FOREIGN KEY (project_id, user_id) REFERENCES project_members(project_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (role_id, project_id) REFERENCES roles(id, project_id) ON DELETE CASCADE
);

INSERT INTO user_roles_new (project_id, user_id, role_id, created_at)
SELECT project_id, user_id, role_id, created_at FROM user_roles;
DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;

INSERT INTO permissions (id, name, description) VALUES
  ('00000000-0000-4000-8000-000000000001', 'data:read', 'Read project data collections'),
  ('00000000-0000-4000-8000-000000000002', 'data:write', 'Create, update, and delete project data'),
  ('00000000-0000-4000-8000-000000000003', 'users:read', 'View project members'),
  ('00000000-0000-4000-8000-000000000004', 'users:write', 'Manage project members'),
  ('00000000-0000-4000-8000-000000000005', 'roles:manage', 'Create and update project roles'),
  ('00000000-0000-4000-8000-000000000006', 'members:manage', 'Assign project roles to members'),
  ('00000000-0000-4000-8000-000000000007', 'api_keys:manage', 'Create and revoke project API keys'),
  ('00000000-0000-4000-8000-000000000008', 'project:manage', 'Update project settings');
