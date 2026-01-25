
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getPrismaClient } from '../infra/prismaClient.js';
import { PrismaProjectRepository } from './repositories.js';
import { ProjectMemberRole } from './models.js';

describe('Project Members', () => {
    const prisma = getPrismaClient();
    const projectRepo = new PrismaProjectRepository(prisma);

    let projectId: string;
    const ownerId = 'user-owner-' + Date.now();
    const memberId = 'user-member-' + Date.now();
    const writerId = 'user-writer-' + Date.now();

    before(async () => {
        // Clean up if needed (or rely on unique IDs)
        const project = await projectRepo.createProject({
            name: 'Test Project ' + Date.now(),
            description: 'Unit test project',
            ownerId: ownerId
        });
        projectId = project.id;
    });

    after(async () => {
        // Cleanup
        if (projectId) {
            await prisma.project.delete({ where: { id: projectId } }).catch(() => { });
        }
    });

    it('should add a member with default READER role', async () => {
        const member = await projectRepo.addMember({
            projectId,
            userId: memberId,
            addedBy: ownerId
        });

        assert.strictEqual(member.projectId, projectId);
        assert.strictEqual(member.userId, memberId);
        assert.strictEqual(member.role, 'READER');
    });

    it('should verify member role is READER', async () => {
        const role = await projectRepo.getMemberRole(projectId, memberId);
        assert.strictEqual(role, 'READER');
    });

    it('should add a member with WRITER role', async () => {
        const member = await projectRepo.addMember({
            projectId,
            userId: writerId,
            role: 'WRITER',
            addedBy: ownerId
        });

        assert.strictEqual(member.role, 'WRITER');
    });

    it('should verify member role is WRITER', async () => {
        const role = await projectRepo.getMemberRole(projectId, writerId);
        assert.strictEqual(role, 'WRITER');
    });

    it('should update member role if added again', async () => {
        const member = await projectRepo.addMember({
            projectId,
            userId: memberId,
            role: 'WRITER',
            addedBy: ownerId
        });

        assert.strictEqual(member.role, 'WRITER');

        const role = await projectRepo.getMemberRole(projectId, memberId);
        assert.strictEqual(role, 'WRITER');
    });

    it('should list all members', async () => {
        const members = await projectRepo.listMembers(projectId);
        assert.strictEqual(members.length, 2);

        const u1 = members.find(m => m.userId === memberId);
        const u2 = members.find(m => m.userId === writerId);

        assert.ok(u1);
        assert.ok(u2);
    });

    it('should remove a member', async () => {
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
