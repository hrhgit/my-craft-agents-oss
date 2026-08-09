/**
 * Tests for BaseAgent abstract class
 *
 * Uses TestAgent (concrete implementation) to verify BaseAgent functionality.
 * Tests model/thinking configuration and lifecycle management.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { AbortReason } from '../backend/types.ts';
import {
  TestAgent,
  createMockBackendConfig,
  collectEvents,
} from './test-utils.ts';

describe('BaseAgent', () => {
  let agent: TestAgent;

  beforeEach(() => {
    agent = new TestAgent(createMockBackendConfig());
  });

  describe('Model Configuration', () => {
    it('should initialize with config model', () => {
      expect(agent.getModel()).toBe('test-model');
    });

    it('should allow setting model', () => {
      agent.setModel('new-model');
      expect(agent.getModel()).toBe('new-model');
    });
  });

  describe('Thinking Level Configuration', () => {
    it('should initialize with config thinking level', () => {
      expect(agent.getThinkingLevel()).toBe('medium');
    });

    it('should allow setting thinking level', () => {
      agent.setThinkingLevel('xhigh');
      expect(agent.getThinkingLevel()).toBe('xhigh');
    });

  });

  describe('Workspace & Session', () => {
    it('should return workspace from config', () => {
      const workspace = agent.getWorkspace();
      expect(workspace.id).toBe('test-workspace-id');
    });

    it('should allow setting workspace', () => {
      agent.setWorkspace({
        schemaVersion: 2,
        id: 'new-workspace',
        revision: 0,
        primaryLocationId: 'primary',
        locations: [{ id: 'primary', name: 'Primary', rootName: 'path', endpoint: { kind: 'local', rootPath: '/new/path' } }],
        name: 'New Workspace',
        nameSource: 'custom',
        slug: 'path',
        createdAt: Date.now(),
      });
      expect(agent.getWorkspace().id).toBe('new-workspace');
    });

    it('should have session ID', () => {
      expect(agent.getSessionId()).toBeTruthy();
    });

    it('should allow setting session ID', () => {
      agent.setSessionId('new-session-id');
      expect(agent.getSessionId()).toBe('new-session-id');
    });
  });

  describe('Clarifications', () => {
    it('should track temporary clarifications', () => {
      agent.setTemporaryClarifications('Test clarification');
      // Clarifications are internal state - verify via PromptBuilder if needed
    });
  });

  describe('Manager Accessors', () => {
    it('should provide access to PromptBuilder', () => {
      const builder = agent.getPromptBuilder();
      expect(builder).toBeTruthy();
    });
  });

  describe('Lifecycle', () => {
    it('should track processing state', () => {
      expect(agent.isProcessing()).toBe(false);
    });

    it('should emit complete event from chat', async () => {
      const events = await collectEvents(agent.chat('test message'));
      expect(events.some(e => e.type === 'complete')).toBe(true);
    });

    it('should track chat calls', async () => {
      await collectEvents(agent.chat('test message'));
      expect(agent.chatCalls).toHaveLength(1);
      expect(agent.chatCalls[0]?.message).toBe('test message');
    });

    it('should track abort calls', async () => {
      await agent.abort('test reason');
      expect(agent.abortCalls).toHaveLength(1);
      expect(agent.abortCalls[0]?.reason).toBe('test reason');
    });

    it('should cleanup on destroy', () => {
      // Should not throw
      agent.destroy();
    });

    it('should cleanup on dispose (alias)', () => {
      // Should not throw
      agent.dispose();
    });
  });

  describe('Callbacks', () => {
    it('should support debug callback', () => {
      let message = '';
      agent.onDebug = (msg) => { message = msg; };

      // Trigger a debug message by setting thinking level
      agent.setThinkingLevel('off');
      expect(message).toContain('Thinking level');
    });

  });

  describe('Config Watcher', () => {
    it('should not start config watcher when skipConfigWatcher is true', () => {
      // Simulates the SessionManager scenario: isHeadless=false but server owns the watcher
      const managedAgent = new TestAgent(createMockBackendConfig({
        isHeadless: false,
        skipConfigWatcher: true,
      }));
      // configWatcherManager should remain null — the guard in startConfigWatcher() returns early
      expect(managedAgent.getConfigWatcherManager()).toBeNull();
      managedAgent.destroy();
    });

    it('should not start config watcher when isHeadless is true (existing behavior)', () => {
      // Simulates temp/headless agents — existing isHeadless guard still works
      const headlessAgent = new TestAgent(createMockBackendConfig({
        isHeadless: true,
      }));
      expect(headlessAgent.getConfigWatcherManager()).toBeNull();
      headlessAgent.destroy();
    });
  });
});
