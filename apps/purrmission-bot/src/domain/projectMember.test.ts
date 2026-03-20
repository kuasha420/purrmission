import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryProjectRepository } from './repositories.mock.js';

describe('Project Members', () => {
  let projectRepo: InMemoryProjectRepository;
  let projectId: string;
  const ownerId = 'user-owner-test';
  const memberId = 'user-member-test';
  const writerId = 'user-writer-test';

  beforeEach(async () => {
    projectRepo = new InMemoryProjectRepository();
    const project = await projectRepo.createProject({
      name: 'Test Project',
      description: 'Unit test project',
      ownerId: ownerId,
    });
    projectId = project.id;
  });

  it('should add a member with default READER role', async () => {
    const member = await projectRepo.addMember({
      projectId,
      userId: memberId,
      addedBy: ownerId,
    });

    assert.strictEqual(member.projectId, projectId);
    assert.strictEqual(member.userId, memberId);
    assert.strictEqual(member.role, 'READER');
  });

  it('should verify member role is READER', async () => {
    await projectRepo.addMember({
      projectId,
      userId: memberId,
      addedBy: ownerId,
    });

    const role = await projectRepo.getMemberRole(projectId, memberId);
    assert.strictEqual(role, 'READER');
  });

  it('should add a member with WRITER role', async () => {
    const member = await projectRepo.addMember({
      projectId,
      userId: writerId,
      role: 'WRITER',
      addedBy: ownerId,
    });

    assert.strictEqual(member.role, 'WRITER');
  });

  it('should verify member role is WRITER', async () => {
    await projectRepo.addMember({
      projectId,
      userId: writerId,
      role: 'WRITER',
      addedBy: ownerId,
    });

    const role = await projectRepo.getMemberRole(projectId, writerId);
    assert.strictEqual(role, 'WRITER');
  });

  it('should update member role if added again', async () => {
    await projectRepo.addMember({
      projectId,
      userId: memberId,
      addedBy: ownerId,
    });

    const member = await projectRepo.addMember({
      projectId,
      userId: memberId,
      role: 'WRITER',
      addedBy: ownerId,
    });

    assert.strictEqual(member.role, 'WRITER');

    const role = await projectRepo.getMemberRole(projectId, memberId);
    assert.strictEqual(role, 'WRITER');
  });

  it('should list all members', async () => {
    await projectRepo.addMember({
      projectId,
      userId: memberId,
      addedBy: ownerId,
    });
    await projectRepo.addMember({
      projectId,
      userId: writerId,
      role: 'WRITER',
      addedBy: ownerId,
    });

    const members = await projectRepo.listMembers(projectId);
    assert.strictEqual(members.length, 2);

    const u1 = members.find((m) => m.userId === memberId);
    const u2 = members.find((m) => m.userId === writerId);

    assert.ok(u1);
    assert.ok(u2);
  });

  it('should remove a member', async () => {
    await projectRepo.addMember({
      projectId,
      userId: memberId,
      addedBy: ownerId,
    });
    await projectRepo.addMember({
      projectId,
      userId: writerId,
      role: 'WRITER',
      addedBy: ownerId,
    });

    await projectRepo.removeMember(projectId, memberId);

    const role = await projectRepo.getMemberRole(projectId, memberId);
    assert.strictEqual(role, null);

    const members = await projectRepo.listMembers(projectId);
    assert.strictEqual(members.length, 1);
  });

  it('should return null role for non-member', async () => {
    const role = await projectRepo.getMemberRole(projectId, 'non-existent-user');
    assert.strictEqual(role, null);
  });
});
