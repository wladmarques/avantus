'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdmin, isStaff, assertAdmin, assertStaff, roleIdsOf } = require('../src/config/permissions');

const settings = {
  get(key) {
    return {
      staff_role_ids: ['111111111111111111'],
      admin_role_ids: ['222222222222222222'],
    }[key];
  },
};

function member({ roles = [], admin = false, owner = false } = {}) {
  const cache = new Map(roles.map((role) => [role, { id: role }]));
  return {
    id: '999999999999999999',
    roles: { cache },
    permissions: { has: (flag) => admin && flag === 'Administrator' },
    guild: { ownerId: owner ? '999999999999999999' : '1' },
  };
}

test('cargos são lidos de Collection, array e _roles', () => {
  assert.deepEqual(roleIdsOf(member({ roles: ['1'] })), ['1']);
  assert.deepEqual(roleIdsOf({ roles: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(roleIdsOf({ _roles: ['x'] }), ['x']);
  assert.deepEqual(roleIdsOf(null), []);
});

test('staff e admin identificados por cargo', () => {
  assert.equal(isStaff(member({ roles: ['111111111111111111'] }), settings), true);
  assert.equal(isStaff(member({ roles: ['333333333333333333'] }), settings), false);
  assert.equal(isAdmin(member({ roles: ['222222222222222222'] }), settings), true);
  // admin também é staff
  assert.equal(isStaff(member({ roles: ['222222222222222222'] }), settings), true);
});

test('Administrator e dono do servidor têm acesso total', () => {
  assert.equal(isAdmin(member({ admin: true }), settings), true);
  assert.equal(isAdmin(member({ owner: true }), settings), true);
});

test('assertStaff/assertAdmin lançam erro amigável', () => {
  assert.throws(() => assertStaff(member(), settings), /não faz parte da equipe/);
  assert.throws(() => assertAdmin(member({ roles: ['111111111111111111'] }), settings), /Apenas administradores/);
  assert.equal(assertStaff(member({ roles: ['111111111111111111'] }), settings), true);
});
