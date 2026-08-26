import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionRecord, StepRecord } from '../sessions/types.ts';

/**
 * SQLite persistence, on Node's built-in driver.
 *
 * Steps are written as they happen rather than at the end, so a run that
 * crashes on step 12 still leaves 11 readable steps behind. That is the whole
 * point: the runs that fail hardest are the ones with the most to tell us, and
 * they are exactly the ones a write-at-the-end design loses.
 */

export type Db = {
  insertSession(record: SessionRecord): void;
  appendStep(sessionId: string, step: StepRecord): void;
  finalizeSession(record: SessionRecord): void;
  saveEvaluation(sessionId: string, evaluationJson: string): void;
  loadSession(sessionId: string): SessionRecord | null;
  listSessionIds(limit: number): string[];
  close(): void;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  start_url          TEXT NOT NULL,
  persona_json       TEXT NOT NULL,
  goal_json          TEXT NOT NULL,
  planner_model      TEXT NOT NULL,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  outcome            TEXT,
  termination_reason TEXT,
  agent_summary      TEXT,
  evaluation_json    TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  session_id       TEXT NOT NULL REFERENCES sessions(id),
  idx              INTEGER NOT NULL,
  generation       INTEGER NOT NULL,
  captured_at      INTEGER NOT NULL,
  url              TEXT NOT NULL,
  title            TEXT NOT NULL,
  observation_text TEXT NOT NULL,
  node_count       INTEGER NOT NULL,
  screenshot_path  TEXT,
  action_json      TEXT,
  result_json      TEXT,
  planner_error    TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, idx)
);

CREATE INDEX IF NOT EXISTS steps_by_session ON steps(session_id, idx);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  // Without WAL a reader inspecting a live run blocks the run itself.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const insertSessionStmt = db.prepare(`
    INSERT INTO sessions (id, start_url, persona_json, goal_json, planner_model, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const appendStepStmt = db.prepare(`
    INSERT OR REPLACE INTO steps (
      session_id, idx, generation, captured_at, url, title, observation_text,
      node_count, screenshot_path, action_json, result_json, planner_error,
      started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const finalizeStmt = db.prepare(`
    UPDATE sessions
       SET ended_at = ?, outcome = ?, termination_reason = ?, agent_summary = ?
     WHERE id = ?
  `);

  const saveEvaluationStmt = db.prepare('UPDATE sessions SET evaluation_json = ? WHERE id = ?');
  const selectSessionStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const selectStepsStmt = db.prepare('SELECT * FROM steps WHERE session_id = ? ORDER BY idx');
  const listStmt = db.prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT ?');

  return {
    insertSession(record) {
      insertSessionStmt.run(
        record.id,
        record.startUrl,
        JSON.stringify(record.persona),
        JSON.stringify(record.goal),
        record.plannerModel,
        record.startedAt,
      );
    },

    appendStep(sessionId, step) {
      appendStepStmt.run(
        sessionId,
        step.index,
        step.observation.generation,
        step.observation.capturedAt,
        step.observation.url,
        step.observation.title,
        step.observation.text,
        step.observation.nodeCount,
        step.observation.screenshotPath,
        step.action === null ? null : JSON.stringify(step.action),
        step.result === null ? null : JSON.stringify(step.result),
        step.plannerError,
        step.startedAt,
        step.endedAt,
      );
    },

    finalizeSession(record) {
      finalizeStmt.run(
        record.endedAt,
        record.outcome,
        record.terminationReason,
        record.agentSummary,
        record.id,
      );
    },

    saveEvaluation(sessionId, evaluationJson) {
      saveEvaluationStmt.run(evaluationJson, sessionId);
    },

    loadSession(sessionId) {
      const row = selectSessionStmt.get(sessionId) as Record<string, unknown> | undefined;
      if (row === undefined) return null;

      const stepRows = selectStepsStmt.all(sessionId) as Record<string, unknown>[];

      return {
        id: String(row['id']),
        startUrl: String(row['start_url']),
        persona: JSON.parse(String(row['persona_json'])),
        goal: JSON.parse(String(row['goal_json'])),
        plannerModel: String(row['planner_model']),
        startedAt: Number(row['started_at']),
        endedAt: row['ended_at'] === null ? null : Number(row['ended_at']),
        outcome: row['outcome'] === null ? null : (String(row['outcome']) as SessionRecord['outcome']),
        terminationReason:
          row['termination_reason'] === null
            ? null
            : (String(row['termination_reason']) as SessionRecord['terminationReason']),
        agentSummary: row['agent_summary'] === null ? null : String(row['agent_summary']),
        steps: stepRows.map(toStepRecord),
      };
    },

    listSessionIds(limit) {
      const rows = listStmt.all(limit) as Record<string, unknown>[];
      return rows.map((row) => String(row['id']));
    },

    close() {
      db.close();
    },
  };
}

function toStepRecord(row: Record<string, unknown>): StepRecord {
  return {
    index: Number(row['idx']),
    observation: {
      generation: Number(row['generation']),
      capturedAt: Number(row['captured_at']),
      url: String(row['url']),
      title: String(row['title']),
      text: String(row['observation_text']),
      nodeCount: Number(row['node_count']),
      screenshotPath: row['screenshot_path'] === null ? null : String(row['screenshot_path']),
    },
    action: row['action_json'] === null ? null : JSON.parse(String(row['action_json'])),
    result: row['result_json'] === null ? null : JSON.parse(String(row['result_json'])),
    plannerError: row['planner_error'] === null ? null : String(row['planner_error']),
    startedAt: Number(row['started_at']),
    endedAt: Number(row['ended_at']),
  };
}
