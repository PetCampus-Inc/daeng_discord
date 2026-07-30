# daeng_discord

## Jira AI review webhook

`POST /webhooks/jira/ai-review` receives Jira transitions into `AI리뷰`, reviews linked Jira/Notion/Figma evidence with the OpenAI Responses API, posts the result directly to Jira, and sends a summary to Discord. Jira Task (`Task`/`작업`) issues are excluded; all other issue types and sprints are eligible.

Required Railway variables:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`
- `JIRA_REVIEW_WEBHOOK_SECRET`
- `OPENAI_API_KEY`

Review integrations:

- `JIRA_SPRINT_FIELD` — defaults to `customfield_10020`
- `OPENAI_MODEL` — defaults to `gpt-5.6-terra`
- `NOTION_TOKEN` — required when a review needs a Notion PRD
- `FIGMA_ACCESS_TOKEN` — required when a review needs Figma
- `REVIEW_DISCORD_WEBHOOK_URL` — falls back to `DISCORD_WEBHOOK_URL`
- `DISCORD_PLANNING_ROLE_ID`
- `DISCORD_DEVELOPMENT_ROLE_ID`

Jira Automation must send JSON in this shape and include the shared secret in the `x-jira-webhook-secret` header:

```json
{
  "issueKey": "{{issue.key}}",
  "issueType": "{{issue.issueType.name}}",
  "summary": "{{issue.summary}}",
  "fromStatus": "{{changelog.status.fromString}}",
  "toStatus": "{{changelog.status.toString}}",
  "updatedAt": "{{issue.updated}}"
}
```

The endpoint queues accepted events in PostgreSQL before returning `202`. Duplicate event keys are ignored, and failed jobs are retried up to three times. A Jira issue can receive at most five successful AI reviews. Re-entering `AI리뷰` without changes to Jira evidence or linked Notion/Figma artifacts is skipped and does not consume a review. Failed jobs also do not consume the review limit. Before posting the Jira comment, Discord receives an `in progress` notification; after Jira succeeds, that same Discord message is updated to `completed`.

To request another review without changing Jira status, add a Jira comment containing exactly `AI 재리뷰`. The service checks recent comments every minute, processes each comment ID once, and posts a Jira explanation when the evidence is unchanged or the five-review limit has been reached.

`GET /api/jira-review/health` returns integration readiness and queue counts when called with the same secret header. It never returns credential values.

## Jira sprint due-date reminder

At 10:00 KST each day, the service checks whether two calendar days have passed since the last successful check. When due, it posts active-sprint unresolved issues without a Jira due date to the AI PM Discord forum and mentions `@everyone`. Empty checks are recorded without posting, so the reminder still keeps its two-day cadence.

`POST /api/jira-sprint-due-reminder/run` runs the check immediately and uses the same `x-jira-webhook-secret` header as the AI review webhook. A successful run is recorded once per KST calendar day to prevent duplicate Discord posts.
