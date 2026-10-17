/**
 * Role_Switcher (task 15.3; Req 13.3, 13.4). A demo stand-in for authentication.
 */
import { useId } from 'react';
import type { StakeholdersResponse } from './apiClient';
import type { Role } from '../core/types';
import { ROLE_LABELS } from './views/shared';

export interface RoleSelection {
  role: Role;
  identityId: string;
}

export interface RoleSwitcherProps {
  directory: StakeholdersResponse;
  value: RoleSelection;
  onChange: (next: RoleSelection) => void;
}

export function firstIdentity(directory: StakeholdersResponse, role: Role): string {
  return directory.stakeholders[role][0]?.id ?? '';
}

export function RoleSwitcher({ directory, value, onChange }: RoleSwitcherProps) {
  const roleId = useId();
  const identityIdField = useId();
  const identities = directory.stakeholders[value.role];
  return (
    <div className="br-switcher" role="group" aria-label="Role switcher">
      <div>
        <label htmlFor={roleId}>View as role</label>
        <select
          id={roleId}
          value={value.role}
          onChange={(e) => {
            const role = e.target.value as Role;
            onChange({ role, identityId: firstIdentity(directory, role) });
          }}
        >
          {directory.roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={identityIdField}>Stakeholder</label>
        <select id={identityIdField} value={value.identityId} onChange={(e) => onChange({ role: value.role, identityId: e.target.value })}>
          {identities.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.id})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
