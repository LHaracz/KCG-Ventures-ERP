-- Employee accounts, admin-defined roles and feature-level access (migration 1 of 2).
--
-- Run in the Supabase SQL editor. Then run bootstrap_admins() with your admin
-- addresses (see the README note in the final report), then
-- employee_access_policies.sql (migration 2), then deploy the code.
--
-- Additive only: new tables, functions, triggers, and nullable account-id
-- columns next to existing "who did this" name columns. No existing row or
-- column is changed. Contains no email addresses. Safe to run more than once.
--
-- Access model:
--   employee_accounts  one row per person (invited, active, deactivated or deleted)
--   roles              named sets of features; the system Admin role has every feature
--   role_features      (role, feature key); feature keys come from src/lib/access/catalog.ts
--   employee_roles     (account, role); an account's features are the UNION of its roles
--   access_audit_log   append-only record of every access change
-- Permission tables are written only by server code (service role) after an
-- Admin check. The browser can only read them through the helper functions.

-- 1) Tables -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  email text,
  first_name text,
  last_name text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'deactivated', 'deleted')),
  invited_by uuid REFERENCES employee_accounts(id) ON DELETE SET NULL,
  invited_at timestamptz,
  accepted_at timestamptz,
  deactivated_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES employee_accounts(id) ON DELETE SET NULL,
  -- The Supabase login still to delete after an account was deleted here
  -- (set when the auth deletion failed, so it can be retried).
  auth_delete_pending_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employee_accounts_email_lower CHECK (email IS NULL OR email = lower(btrim(email))),
  CONSTRAINT employee_accounts_deleted_cleared CHECK (status <> 'deleted' OR (email IS NULL AND user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_accounts_email_unique ON employee_accounts (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  is_admin boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES employee_accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_name_unique_ci ON roles (lower(btrim(name)));
-- Exactly one admin role can exist (the system Admin role).
CREATE UNIQUE INDEX IF NOT EXISTS roles_single_admin ON roles (is_admin) WHERE is_admin;

CREATE TABLE IF NOT EXISTS role_features (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  feature_key text NOT NULL CHECK (feature_key ~ '^[a-z_]+\.[a-z_]+$'),
  PRIMARY KEY (role_id, feature_key)
);

CREATE TABLE IF NOT EXISTS employee_roles (
  employee_id uuid NOT NULL REFERENCES employee_accounts(id) ON DELETE CASCADE,
  -- RESTRICT: a role cannot be deleted while anyone holds it.
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  PRIMARY KEY (employee_id, role_id)
);
CREATE INDEX IF NOT EXISTS employee_roles_role_idx ON employee_roles (role_id);

CREATE TABLE IF NOT EXISTS access_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_name text NOT NULL,
  actor_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('invited', 'invite_resent', 'invite_revoked', 'roles_changed', 'role_created',
    'role_edited', 'role_deleted', 'deactivated', 'reactivated', 'deleted', 'profile_completed', 'admin_bootstrapped')),
  target text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_audit_log_created_idx ON access_audit_log (created_at DESC);

-- Row level security: on, with no policy for anon and no write policy for
-- authenticated. Server code (service role) does every write.
ALTER TABLE employee_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_features ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON employee_accounts, roles, role_features, employee_roles, access_audit_log FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON employee_accounts, roles, role_features, employee_roles, access_audit_log FROM authenticated;

-- 2) Helper functions (used by policies and by the app) -----------------------
-- Every answer comes from the current rows for auth.uid(), so deactivating or
-- deleting someone takes effect on their very next request.
CREATE OR REPLACE FUNCTION current_account_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id FROM employee_accounts a
  WHERE a.user_id = auth.uid() AND a.status = 'active' AND auth.uid() IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION is_active_employee() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT current_account_id() IS NOT NULL
$$;

CREATE OR REPLACE FUNCTION is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id
    WHERE er.employee_id = current_account_id() AND r.is_admin
  )
$$;

CREATE OR REPLACE FUNCTION has_feature(key text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1 FROM employee_roles er JOIN role_features rf ON rf.role_id = er.role_id
    WHERE er.employee_id = current_account_id() AND rf.feature_key = key
  )
$$;

CREATE OR REPLACE FUNCTION has_any_feature(keys text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1 FROM employee_roles er JOIN role_features rf ON rf.role_id = er.role_id
    WHERE er.employee_id = current_account_id() AND rf.feature_key = ANY (keys)
  )
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['current_account_id()', 'is_active_employee()', 'is_admin()', 'has_feature(text)', 'has_any_feature(text[])'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END $$;

-- 3) Guards -------------------------------------------------------------------
-- An "active admin" is an active account, linked to a login, holding the Admin role.
CREATE OR REPLACE FUNCTION access_active_admin_count(p_exclude_account uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(DISTINCT a.id)::integer
  FROM employee_accounts a
  JOIN employee_roles er ON er.employee_id = a.id
  JOIN roles r ON r.id = er.role_id AND r.is_admin
  WHERE a.status = 'active' AND a.user_id IS NOT NULL
    AND (p_exclude_account IS NULL OR a.id <> p_exclude_account)
$$;

CREATE OR REPLACE FUNCTION access_is_active_admin(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM employee_accounts a
    JOIN employee_roles er ON er.employee_id = a.id
    JOIN roles r ON r.id = er.role_id AND r.is_admin
    WHERE a.id = p_account AND a.status = 'active' AND a.user_id IS NOT NULL
  )
$$;

-- Never lock out the last admin: removing the Admin role from, deactivating,
-- deleting or unlinking the last active admin is refused.
CREATE OR REPLACE FUNCTION employee_roles_last_admin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_is_admin_role boolean;
BEGIN
  SELECT is_admin INTO v_is_admin_role FROM roles WHERE id = OLD.role_id;
  IF coalesce(v_is_admin_role, false) THEN
    PERFORM pg_advisory_xact_lock(hashtext('kcg_last_admin'));
    IF access_is_active_admin(OLD.employee_id) AND access_active_admin_count(OLD.employee_id) = 0 THEN
      RAISE EXCEPTION 'The last active admin cannot lose the Admin role.' USING ERRCODE = 'P0001', HINT = 'last_admin';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS employee_roles_last_admin ON employee_roles;
CREATE TRIGGER employee_roles_last_admin BEFORE DELETE OR UPDATE ON employee_roles
  FOR EACH ROW EXECUTE FUNCTION employee_roles_last_admin_guard();

CREATE OR REPLACE FUNCTION employee_accounts_last_admin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'active' AND NEW.user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('kcg_last_admin'));
  IF access_is_active_admin(OLD.id) AND access_active_admin_count(OLD.id) = 0 THEN
    RAISE EXCEPTION 'The last active admin cannot be deactivated or deleted.' USING ERRCODE = 'P0001', HINT = 'last_admin';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS employee_accounts_last_admin ON employee_accounts;
CREATE TRIGGER employee_accounts_last_admin BEFORE DELETE OR UPDATE ON employee_accounts
  FOR EACH ROW EXECUTE FUNCTION employee_accounts_last_admin_guard();

-- Deleted accounts keep only first and last name.
CREATE OR REPLACE FUNCTION employee_accounts_status_dates() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN NEW.email := lower(btrim(NEW.email)); END IF;
  IF NEW.status = 'deleted' THEN
    NEW.email := NULL;
    NEW.user_id := NULL;
    NEW.deleted_at := coalesce(NEW.deleted_at, now());
  END IF;
  IF NEW.status = 'deactivated' AND (TG_OP = 'INSERT' OR OLD.status <> 'deactivated') THEN
    NEW.deactivated_at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'deleted' AND NEW.status <> 'deleted' THEN
    RAISE EXCEPTION 'A deleted account cannot be restored. Invite the person again.' USING ERRCODE = 'P0001', HINT = 'deleted';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS employee_accounts_status_dates ON employee_accounts;
CREATE TRIGGER employee_accounts_status_dates BEFORE INSERT OR UPDATE ON employee_accounts
  FOR EACH ROW EXECUTE FUNCTION employee_accounts_status_dates();

-- The system Admin role is locked: it can't be renamed, deleted, or have its
-- flags changed, and no other role can become an admin role.
CREATE OR REPLACE FUNCTION roles_system_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN RAISE EXCEPTION 'The Admin role cannot be deleted.' USING ERRCODE = 'P0001', HINT = 'system_role'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_system AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.is_admin IS DISTINCT FROM OLD.is_admin OR NEW.is_system IS DISTINCT FROM OLD.is_system) THEN
      RAISE EXCEPTION 'The Admin role is locked.' USING ERRCODE = 'P0001', HINT = 'system_role';
    END IF;
    IF NOT OLD.is_system AND (NEW.is_admin OR NEW.is_system) THEN
      RAISE EXCEPTION 'Only the system Admin role has full access.' USING ERRCODE = 'P0001', HINT = 'system_role';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS roles_system_guard ON roles;
CREATE TRIGGER roles_system_guard BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION roles_system_guard();

-- Admin has every feature implicitly; feature rows on it would be misleading.
CREATE OR REPLACE FUNCTION role_features_not_admin() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM roles WHERE id = NEW.role_id AND is_admin) THEN
    RAISE EXCEPTION 'The Admin role already has every feature.' USING ERRCODE = 'P0001', HINT = 'system_role';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS role_features_not_admin ON role_features;
CREATE TRIGGER role_features_not_admin BEFORE INSERT OR UPDATE ON role_features
  FOR EACH ROW EXECUTE FUNCTION role_features_not_admin();

-- The audit log is append-only.
CREATE OR REPLACE FUNCTION access_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'access_audit_log is append-only.' USING ERRCODE = 'P0001', HINT = 'append_only';
END $$;
DROP TRIGGER IF EXISTS access_audit_log_no_update ON access_audit_log;
CREATE TRIGGER access_audit_log_no_update BEFORE UPDATE OR DELETE ON access_audit_log
  FOR EACH ROW EXECUTE FUNCTION access_audit_log_append_only();
DROP TRIGGER IF EXISTS access_audit_log_no_truncate ON access_audit_log;
CREATE TRIGGER access_audit_log_no_truncate BEFORE TRUNCATE ON access_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION access_audit_log_append_only();

-- 4) Seed roles ---------------------------------------------------------------
-- Created once. If a role with the name already exists (for example after an
-- admin edited it), it is left exactly as it is.
DO $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM roles WHERE is_admin) THEN
    INSERT INTO roles (name, description, is_admin, is_system)
    VALUES ('Admin', 'Full access to everything, including features added in the future.', true, true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM roles WHERE lower(btrim(name)) = 'warehouse operations') THEN
    INSERT INTO roles (name, description) VALUES ('Warehouse Operations', 'Inventory, orders and picking, and compliance documents.')
    RETURNING id INTO v_id;
    INSERT INTO role_features (role_id, feature_key)
    SELECT v_id, k FROM unnest(ARRAY['inventory.finished_products', 'inventory.raw_materials', 'inventory.purchase_orders',
      'fulfillment.orders', 'fulfillment.pick_list', 'compliance.sops', 'compliance.logs', 'compliance.coas']) k;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM roles WHERE lower(btrim(name)) = 'production operations') THEN
    INSERT INTO roles (name, description) VALUES ('Production Operations', 'Production planning and formulation, inventory, and compliance documents.')
    RETURNING id INTO v_id;
    INSERT INTO role_features (role_id, feature_key)
    SELECT v_id, k FROM unnest(ARRAY['production.calibration', 'production.products_bom', 'production.planner',
      'production.optimization', 'production.formulation', 'inventory.finished_products', 'inventory.raw_materials',
      'inventory.purchase_orders', 'compliance.sops', 'compliance.logs', 'compliance.coas']) k;
  END IF;
END $$;

-- 5) Admin bootstrap ----------------------------------------------------------
COMMENT ON TABLE employee_accounts IS 'ERP employee accounts. No rows are seeded by migrations; the first admins are created with bootstrap_admins() from the Supabase SQL editor.';

CREATE OR REPLACE FUNCTION bootstrap_admins(admin_emails text[])
RETURNS TABLE (email text, result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth, pg_temp AS $$
DECLARE
  v_email text;
  v_user uuid;
  v_account uuid;
  v_admin_role uuid;
  v_changed boolean;
BEGIN
  SELECT id INTO v_admin_role FROM public.roles WHERE is_admin;
  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'The Admin role is missing. Run migration 1 first.';
  END IF;

  FOR v_email IN
    SELECT DISTINCT lower(btrim(e)) FROM unnest(coalesce(admin_emails, ARRAY[]::text[])) e
    WHERE e IS NOT NULL AND btrim(e) <> ''
    ORDER BY 1
  LOOP
    v_changed := false;
    SELECT u.id INTO v_user FROM auth.users u WHERE lower(u.email) = v_email LIMIT 1;
    IF v_user IS NULL THEN
      email := v_email; result := 'no sign-in account found';
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT a.id INTO v_account FROM public.employee_accounts a WHERE a.user_id = v_user;
    IF v_account IS NULL THEN
      SELECT a.id INTO v_account FROM public.employee_accounts a WHERE a.email = v_email AND a.status <> 'deleted';
    END IF;

    IF v_account IS NULL THEN
      INSERT INTO public.employee_accounts (user_id, email, status, invited_at, accepted_at)
      VALUES (v_user, v_email, 'active', now(), now())
      RETURNING id INTO v_account;
      v_changed := true;
    ELSE
      UPDATE public.employee_accounts a
        SET user_id = v_user, email = v_email, status = 'active', accepted_at = coalesce(a.accepted_at, now())
        WHERE a.id = v_account
          AND (a.user_id IS DISTINCT FROM v_user OR a.email IS DISTINCT FROM v_email OR a.status <> 'active' OR a.accepted_at IS NULL);
      IF FOUND THEN v_changed := true; END IF;
    END IF;

    INSERT INTO public.employee_roles (employee_id, role_id) VALUES (v_account, v_admin_role)
      ON CONFLICT DO NOTHING;
    IF FOUND THEN v_changed := true; END IF;

    IF v_changed THEN
      INSERT INTO public.access_audit_log (actor_name, actor_account_id, action, target, detail)
      VALUES ('System', NULL, 'admin_bootstrapped', v_email, '{}'::jsonb);
    END IF;

    email := v_email;
    result := CASE WHEN v_changed THEN 'admin added' ELSE 'already admin' END;
    RETURN NEXT;
  END LOOP;
END $$;

COMMENT ON FUNCTION bootstrap_admins(text[]) IS
  'Makes existing Supabase logins ERP Admins. Run only from the Supabase SQL editor (database owner). '
  'Execute is granted to nobody, so it is never reachable through the app or the public API. '
  'It never creates logins and stores the addresses only in employee_accounts and the audit log target.';
REVOKE ALL ON FUNCTION bootstrap_admins(text[]) FROM public, anon, authenticated, service_role;

-- 6) Server-side admin operations (service role only, called after an Admin check) --
-- Each is one transaction and writes its audit rows. p_actor is the admin's
-- account id; the actor name is read from that account.
CREATE OR REPLACE FUNCTION access_actor_name(p_actor uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), 'Admin') FROM employee_accounts WHERE id = p_actor
$$;

CREATE OR REPLACE FUNCTION access_fail(p_code text, p_message text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', p_message USING ERRCODE = 'P0001', HINT = p_code;
END $$;

-- Replace an account's roles. Refuses an empty set for an active or invited account.
CREATE OR REPLACE FUNCTION admin_set_employee_roles(p_actor uuid, p_account uuid, p_role_ids uuid[], p_action text DEFAULT 'roles_changed')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_acc employee_accounts; v_before text[]; v_after text[];
BEGIN
  SELECT * INTO v_acc FROM employee_accounts WHERE id = p_account FOR UPDATE;
  IF v_acc.id IS NULL OR v_acc.status = 'deleted' THEN PERFORM access_fail('not_found', 'Account not found.'); END IF;
  IF coalesce(array_length(p_role_ids, 1), 0) = 0 THEN PERFORM access_fail('roles_required', 'Choose at least one role.'); END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_role_ids) r WHERE NOT EXISTS (SELECT 1 FROM roles WHERE id = r)) THEN
    PERFORM access_fail('role_not_found', 'One of the roles no longer exists.');
  END IF;
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}') INTO v_before
    FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = p_account;
  DELETE FROM employee_roles WHERE employee_id = p_account AND role_id <> ALL (p_role_ids);
  INSERT INTO employee_roles (employee_id, role_id) SELECT p_account, r FROM unnest(p_role_ids) r ON CONFLICT DO NOTHING;
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}') INTO v_after
    FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = p_account;
  IF p_action = 'roles_changed' AND v_before IS NOT DISTINCT FROM v_after THEN
    RETURN jsonb_build_object('changed', false);
  END IF;
  IF p_action = 'roles_changed' THEN
    INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
    VALUES (access_actor_name(p_actor), p_actor, 'roles_changed',
            btrim(concat_ws(' ', v_acc.first_name, v_acc.last_name)),
            jsonb_build_object('account_id', p_account, 'before', to_jsonb(v_before), 'after', to_jsonb(v_after)));
  END IF;
  RETURN jsonb_build_object('changed', true, 'roles', to_jsonb(v_after));
END $$;

-- New invitation (or re-invitation of a deleted person's address).
CREATE OR REPLACE FUNCTION admin_create_invite(p_actor uuid, p_first text, p_last text, p_email text, p_role_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_email text := lower(btrim(p_email)); v_id uuid;
BEGIN
  IF btrim(coalesce(p_first, '')) = '' OR btrim(coalesce(p_last, '')) = '' THEN
    PERFORM access_fail('name_required', 'First and last name are required.');
  END IF;
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN PERFORM access_fail('bad_email', 'Enter a valid email address.'); END IF;
  IF EXISTS (SELECT 1 FROM employee_accounts WHERE email = v_email AND status IN ('invited', 'active', 'deactivated')) THEN
    PERFORM access_fail('email_exists', 'Someone with this email already has an account.');
  END IF;
  INSERT INTO employee_accounts (email, first_name, last_name, status, invited_by, invited_at)
  VALUES (v_email, btrim(p_first), btrim(p_last), 'invited', p_actor, now())
  RETURNING id INTO v_id;
  PERFORM admin_set_employee_roles(p_actor, v_id, p_role_ids, 'invited');
  -- The 'invited' audit row is written by admin_finish_invite once the
  -- invitation email was actually sent (a failed send removes this row).
  RETURN v_id;
END $$;

-- After the invite email was sent: store the login id and write the audit row.
CREATE OR REPLACE FUNCTION admin_finish_invite(p_actor uuid, p_account uuid, p_user uuid, p_action text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_acc employee_accounts;
BEGIN
  IF p_action NOT IN ('invited', 'invite_resent') THEN PERFORM access_fail('bad_action', 'Unknown invite action.'); END IF;
  UPDATE employee_accounts SET user_id = coalesce(p_user, user_id), invited_at = now()
    WHERE id = p_account AND status = 'invited'
    RETURNING * INTO v_acc;
  IF v_acc.id IS NULL THEN PERFORM access_fail('not_invited', 'This account is not waiting for an invite.'); END IF;
  INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
  VALUES (access_actor_name(p_actor), p_actor, p_action, btrim(concat_ws(' ', v_acc.first_name, v_acc.last_name)),
          jsonb_strip_nulls(jsonb_build_object('account_id', p_account, 'note', p_note, 'roles',
            (SELECT to_jsonb(coalesce(array_agg(r.name ORDER BY r.name), '{}')) FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = p_account))));
  RETURN jsonb_build_object('ok', true);
END $$;

-- A failed invitation send: remove the just-created invited account (nothing
-- else references it yet).
CREATE OR REPLACE FUNCTION admin_discard_invite(p_account uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM employee_accounts WHERE id = p_account AND status = 'invited' AND accepted_at IS NULL;
END $$;

-- Deactivate or reactivate.
CREATE OR REPLACE FUNCTION admin_set_employee_status(p_actor uuid, p_account uuid, p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_acc employee_accounts;
BEGIN
  SELECT * INTO v_acc FROM employee_accounts WHERE id = p_account FOR UPDATE;
  IF v_acc.id IS NULL OR v_acc.status = 'deleted' THEN PERFORM access_fail('not_found', 'Account not found.'); END IF;
  IF p_active THEN
    IF v_acc.status <> 'deactivated' THEN PERFORM access_fail('not_deactivated', 'Only a deactivated account can be reactivated.'); END IF;
    UPDATE employee_accounts
      SET status = CASE WHEN accepted_at IS NULL THEN 'invited' ELSE 'active' END, deactivated_at = NULL
      WHERE id = p_account;
  ELSE
    IF v_acc.status NOT IN ('active', 'invited') THEN PERFORM access_fail('not_active', 'This account is not active.'); END IF;
    IF p_account = p_actor THEN PERFORM access_fail('self', 'You cannot deactivate your own account.'); END IF;
    UPDATE employee_accounts SET status = 'deactivated' WHERE id = p_account;
  END IF;
  INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
  VALUES (access_actor_name(p_actor), p_actor, CASE WHEN p_active THEN 'reactivated' ELSE 'deactivated' END,
          btrim(concat_ws(' ', v_acc.first_name, v_acc.last_name)), jsonb_build_object('account_id', p_account));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Delete step 1 (one transaction): mark deleted, remove role links, clear
-- email and login (access ends now). Returns the login to delete next with the
-- admin API; it stays in auth_delete_pending_user_id until that succeeds.
CREATE OR REPLACE FUNCTION admin_delete_employee(p_actor uuid, p_account uuid, p_action text DEFAULT 'deleted')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_acc employee_accounts;
BEGIN
  SELECT * INTO v_acc FROM employee_accounts WHERE id = p_account FOR UPDATE;
  IF v_acc.id IS NULL THEN PERFORM access_fail('not_found', 'Account not found.'); END IF;
  IF p_account = p_actor THEN PERFORM access_fail('self', 'You cannot delete your own account.'); END IF;
  IF v_acc.status = 'deleted' THEN
    RETURN jsonb_build_object('user_id', v_acc.auth_delete_pending_user_id, 'already', true);
  END IF;
  -- Refuses the last active admin before anything changes.
  IF access_is_active_admin(p_account) AND access_active_admin_count(p_account) = 0 THEN
    PERFORM access_fail('last_admin', 'The last active admin cannot be deleted.');
  END IF;
  DELETE FROM employee_roles WHERE employee_id = p_account;
  UPDATE employee_accounts
    SET status = 'deleted', deleted_by = p_actor, auth_delete_pending_user_id = v_acc.user_id
    WHERE id = p_account;
  INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
  VALUES (access_actor_name(p_actor), p_actor, p_action, btrim(concat_ws(' ', v_acc.first_name, v_acc.last_name)),
          jsonb_build_object('account_id', p_account, 'previous_status', v_acc.status));
  RETURN jsonb_build_object('user_id', v_acc.user_id, 'already', false);
END $$;

-- Roles: create or edit (name, description, features) and delete.
CREATE OR REPLACE FUNCTION admin_save_role(p_actor uuid, p_role uuid, p_name text, p_description text, p_features text[])
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_role roles; v_id uuid; v_before text[]; v_after text[];
BEGIN
  IF btrim(coalesce(p_name, '')) = '' THEN PERFORM access_fail('name_required', 'Enter a role name.'); END IF;
  IF EXISTS (SELECT 1 FROM roles WHERE lower(btrim(name)) = lower(btrim(p_name)) AND (p_role IS NULL OR id <> p_role)) THEN
    PERFORM access_fail('name_taken', 'Another role already has this name.');
  END IF;
  IF p_role IS NULL THEN
    INSERT INTO roles (name, description, created_by) VALUES (btrim(p_name), nullif(btrim(p_description), ''), p_actor)
    RETURNING id INTO v_id;
    v_before := '{}';
  ELSE
    SELECT * INTO v_role FROM roles WHERE id = p_role FOR UPDATE;
    IF v_role.id IS NULL THEN PERFORM access_fail('not_found', 'Role not found.'); END IF;
    IF v_role.is_system THEN PERFORM access_fail('system_role', 'The Admin role is locked.'); END IF;
    v_id := p_role;
    SELECT coalesce(array_agg(feature_key ORDER BY feature_key), '{}') INTO v_before FROM role_features WHERE role_id = v_id;
    UPDATE roles SET name = btrim(p_name), description = nullif(btrim(p_description), '') WHERE id = v_id;
  END IF;
  DELETE FROM role_features WHERE role_id = v_id AND feature_key <> ALL (coalesce(p_features, '{}'));
  INSERT INTO role_features (role_id, feature_key)
    SELECT v_id, k FROM unnest(coalesce(p_features, '{}')) k ON CONFLICT DO NOTHING;
  SELECT coalesce(array_agg(feature_key ORDER BY feature_key), '{}') INTO v_after FROM role_features WHERE role_id = v_id;
  INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
  VALUES (access_actor_name(p_actor), p_actor, CASE WHEN p_role IS NULL THEN 'role_created' ELSE 'role_edited' END, btrim(p_name),
          jsonb_build_object('role_id', v_id, 'before_name', v_role.name, 'features_before', to_jsonb(v_before),
                             'features_after', to_jsonb(v_after),
                             'employees_affected', (SELECT count(*) FROM employee_roles WHERE role_id = v_id)));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION admin_delete_role(p_actor uuid, p_role uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE v_role roles; v_n integer;
BEGIN
  SELECT * INTO v_role FROM roles WHERE id = p_role FOR UPDATE;
  IF v_role.id IS NULL THEN PERFORM access_fail('not_found', 'Role not found.'); END IF;
  IF v_role.is_system THEN PERFORM access_fail('system_role', 'The Admin role cannot be deleted.'); END IF;
  SELECT count(*) INTO v_n FROM employee_roles WHERE role_id = p_role;
  IF v_n > 0 THEN PERFORM access_fail('role_in_use', format('%s employee(s) still have this role. Remove it from them first.', v_n)); END IF;
  DELETE FROM roles WHERE id = p_role;
  INSERT INTO access_audit_log (actor_name, actor_account_id, action, target, detail)
  VALUES (access_actor_name(p_actor), p_actor, 'role_deleted', v_role.name, jsonb_build_object('role_id', p_role));
  RETURN jsonb_build_object('ok', true);
END $$;

-- What the app needs on every request for one login: the account, whether it
-- is an Admin, its roles, and the union of its roles' features. Read fresh
-- from the tables each time (no caching), so changes apply on the next request.
CREATE OR REPLACE FUNCTION access_for_user(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
    'account_id', a.id,
    'status', a.status,
    'first_name', a.first_name,
    'last_name', a.last_name,
    'email', a.email,
    'is_admin', EXISTS (SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = a.id AND r.is_admin),
    'roles', coalesce((SELECT jsonb_agg(r.name ORDER BY r.name) FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = a.id), '[]'::jsonb),
    'features', coalesce((SELECT jsonb_agg(DISTINCT rf.feature_key) FROM employee_roles er JOIN role_features rf ON rf.role_id = er.role_id WHERE er.employee_id = a.id), '[]'::jsonb)
  ) END
  FROM (SELECT 1) one LEFT JOIN employee_accounts a ON a.user_id = p_user AND p_user IS NOT NULL
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'access_for_user(uuid)',
    'access_active_admin_count(uuid)', 'access_is_active_admin(uuid)', 'access_actor_name(uuid)', 'access_fail(text, text)',
    'admin_set_employee_roles(uuid, uuid, uuid[], text)', 'admin_create_invite(uuid, text, text, text, uuid[])',
    'admin_finish_invite(uuid, uuid, uuid, text, text)', 'admin_discard_invite(uuid)',
    'admin_set_employee_status(uuid, uuid, boolean)', 'admin_delete_employee(uuid, uuid, text)',
    'admin_save_role(uuid, uuid, text, text, text[])', 'admin_delete_role(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM public, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- 7) "Who did this" from the signed-in account ------------------------------
-- New nullable account-id columns next to the existing name snapshots. Old
-- rows keep their roster id and name untouched.
ALTER TABLE log_entries ADD COLUMN IF NOT EXISTS performed_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE log_entry_reviews ADD COLUMN IF NOT EXISTS reviewed_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE log_entry_files ADD COLUMN IF NOT EXISTS added_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE batch_compliance_reviews ADD COLUMN IF NOT EXISTS acknowledged_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE sop_versions ADD COLUMN IF NOT EXISTS published_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS prepared_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;
ALTER TABLE order_status ADD COLUMN IF NOT EXISTS flagged_by_account_id uuid REFERENCES employee_accounts(id) ON DELETE SET NULL;

-- Full name of the signed-in employee, or null (not signed in as an active
-- employee, or the profile has no name yet).
CREATE OR REPLACE FUNCTION current_account_name() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT nullif(btrim(concat_ws(' ', nullif(btrim(first_name), ''), nullif(btrim(last_name), ''))), '')
  FROM employee_accounts WHERE id = current_account_id() AND btrim(coalesce(first_name, '')) <> '' AND btrim(coalesce(last_name, '')) <> ''
$$;
REVOKE ALL ON FUNCTION current_account_name() FROM public, anon;
GRANT EXECUTE ON FUNCTION current_account_name() TO authenticated;

-- BEFORE INSERT: when a signed-in employee writes the row through the browser,
-- the stored name and account id come from their account, whatever the
-- browser sent. Server code (service role) sets them itself from the session.
-- TG_ARGV[0] = name column, TG_ARGV[1] = account id column, TG_ARGV[2] =
-- (optional) the column holding the login id on server inserts
-- (default created_by_account).
CREATE OR REPLACE FUNCTION fill_actor_from_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := current_account_id(); v_name text; v_login text;
BEGIN
  IF v_id IS NULL THEN
    -- Server (service role) inserts: the server set the name from the
    -- session; fill the account id from the login recorded on the row.
    v_login := to_jsonb(NEW) ->> coalesce(TG_ARGV[2], 'created_by_account');
    IF v_login IS NOT NULL AND (to_jsonb(NEW) ->> TG_ARGV[1]) IS NULL THEN
      SELECT id INTO v_id FROM employee_accounts WHERE user_id = v_login::uuid AND status = 'active';
      IF v_id IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], v_id));
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  v_name := current_account_name();
  IF v_name IS NULL THEN RETURN NEW; END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], v_name, TG_ARGV[1], v_id));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS log_entries_actor ON log_entries;
CREATE TRIGGER log_entries_actor BEFORE INSERT ON log_entries
  FOR EACH ROW EXECUTE FUNCTION fill_actor_from_account('performed_by_name', 'performed_by_account_id');
DROP TRIGGER IF EXISTS log_entry_reviews_actor ON log_entry_reviews;
CREATE TRIGGER log_entry_reviews_actor BEFORE INSERT ON log_entry_reviews
  FOR EACH ROW EXECUTE FUNCTION fill_actor_from_account('reviewed_by_name', 'reviewed_by_account_id');
-- SOP versions are published by server code; the publisher's account comes
-- from the login it records (uploaded_by).
DROP TRIGGER IF EXISTS sop_versions_actor ON sop_versions;
CREATE TRIGGER sop_versions_actor BEFORE INSERT ON sop_versions
  FOR EACH ROW EXECUTE FUNCTION fill_actor_from_account('published_by_name', 'published_by_account_id', 'uploaded_by');
DROP TRIGGER IF EXISTS log_entry_files_actor ON log_entry_files;
CREATE TRIGGER log_entry_files_actor BEFORE INSERT ON log_entry_files
  FOR EACH ROW EXECUTE FUNCTION fill_actor_from_account('added_by_name', 'added_by_account_id');

-- Acknowledging release warnings happens on UPDATE (acknowledged_at set).
CREATE OR REPLACE FUNCTION batch_compliance_reviews_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := current_account_id(); v_name text;
BEGIN
  IF v_id IS NULL OR NEW.acknowledged_at IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.acknowledged_at IS NOT NULL THEN RETURN NEW; END IF;
  v_name := current_account_name();
  IF v_name IS NULL THEN RETURN NEW; END IF;
  NEW.acknowledged_by_name := v_name;
  NEW.acknowledged_by_account_id := v_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS batch_compliance_reviews_actor ON batch_compliance_reviews;
CREATE TRIGGER batch_compliance_reviews_actor BEFORE INSERT OR UPDATE ON batch_compliance_reviews
  FOR EACH ROW EXECUTE FUNCTION batch_compliance_reviews_actor();

-- Flagging an order records who flagged it.
CREATE OR REPLACE FUNCTION order_status_flagged_by_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := current_account_id(); v_name text;
BEGIN
  IF v_id IS NULL OR NOT coalesce(NEW.is_flagged, false) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND coalesce(OLD.is_flagged, false)
     AND NEW.flagged_reason IS NOT DISTINCT FROM OLD.flagged_reason
     AND NEW.flagged_by IS NOT DISTINCT FROM OLD.flagged_by THEN
    RETURN NEW;
  END IF;
  v_name := current_account_name();
  IF v_name IS NULL THEN RETURN NEW; END IF;
  NEW.flagged_by := v_name;
  NEW.flagged_by_account_id := v_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS order_status_flagged_by_actor ON order_status;
CREATE TRIGGER order_status_flagged_by_actor BEFORE INSERT OR UPDATE ON order_status
  FOR EACH ROW EXECUTE FUNCTION order_status_flagged_by_actor();

REVOKE ALL ON FUNCTION fill_actor_from_account() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION batch_compliance_reviews_actor() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION order_status_flagged_by_actor() FROM public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
