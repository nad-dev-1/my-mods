// Types for core.js (plain JavaScript, shared with the dashboard page). Loose on purpose: the page inlines the same file.
/* eslint-disable */
export declare const PRIORITIES: string[]
export declare const TASK_STAGES: string[]
export declare const IDEA_STAGES: string[]
export declare const NOTE_TAGS: string[]
export declare const STAGE_LABEL: Record<string, string>
export declare const PRIORITY_LABEL: Record<string, string>
export declare const DEFAULT_SETTINGS: Record<string, any>
export declare const PERIODS: Record<string, string>
export declare const JIRA_FIELDS: string[]
export declare function todayIn(...args: any[]): any
export declare function addDays(...args: any[]): any
export declare function daysBetween(...args: any[]): any
export declare function isDate(...args: any[]): any
export declare function weekStart(...args: any[]): any
export declare function periodRange(...args: any[]): any
export declare function formatId(...args: any[]): any
export declare function nextId(...args: any[]): any
export declare function slugify(...args: any[]): any
export declare function rankBetween(...args: any[]): any
export declare function ranksAfter(...args: any[]): any
export declare function normalizeJiraKey(...args: any[]): any
export declare function jiraKeysFrom(...args: any[]): any
export declare function byPriority(...args: any[]): any
export declare function byQueue(...args: any[]): any
export declare function lastRankIn(...args: any[]): any
export declare function lastQueueRank(...args: any[]): any
export declare function eventId(...args: any[]): any
export declare function systemEvent(...args: any[]): any
export declare function noteEvent(...args: any[]): any
export declare function newItem(...args: any[]): any
export declare function applyChange(...args: any[]): any
export declare function convertIdea(...args: any[]): any
export declare function openBlockers(...args: any[]): any
export declare function flagsFor(...args: any[]): any
export declare function isOngoing(...args: any[]): any
export declare function isOpenTask(...args: any[]): any
export declare function wipOver(...args: any[]): any
export declare function jiraSnapshot(...args: any[]): any
export declare function issuesFrom(...args: any[]): any
export declare function jiraChunks(...args: any[]): any
export declare function filterItems(...args: any[]): any
export declare function scopeOf(...args: any[]): any
export declare function computeReport(...args: any[]): any
export declare function reportMarkdown(...args: any[]): any
export declare function reportCsv(...args: any[]): any
export declare function summaryFacts(...args: any[]): any
export declare function statusLine(...args: any[]): any
