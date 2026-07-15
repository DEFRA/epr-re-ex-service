---
name: jira
description: Talk to the JIRA instance at https://eaflood.atlassian.net using JIRA_TOKEN env var. Use for fetching issue details, adding comments, transitioning status, and searching issues. TRIGGER automatically whenever the user mentions a PAE-[number] pattern (e.g. PAE-1288, PAE-42) and asks for details, status, or any information about the issue.
---

# /jira — Interact with JIRA

## Auto-trigger

Invoke this skill automatically when:
- The user mentions `PAE-[number]` (e.g. "what's in PAE-1288?", "show me PAE-42", "tell me about PAE-1288")
- The user asks for details, status, acceptance criteria, or comments on any PAE issue
- No explicit `/jira` command is needed — a bare `PAE-XXXX` reference is sufficient

Fetch, update, and comment on JIRA issues at `https://eaflood.atlassian.net` using the `JIRA_TOKEN` environment variable.

## Usage

```
/jira PAE-1288
/jira PAE-1288 comment "My comment text"
/jira PAE-1288 transition "In Progress"
/jira search "project = PAE AND sprint in openSprints()"
```

## Prerequisites

Required env vars — also used by [release-notes](../release-notes/SKILL.md) to fetch PAE issue summaries:
- `JIRA_TOKEN` — API token from https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_EMAIL` — your Atlassian account email address

## Auth setup

Atlassian Cloud (`*.atlassian.net`) requires **Basic auth** with an API token, not Bearer:

```
Authorization: Basic base64($JIRA_EMAIL:$JIRA_TOKEN)
Content-Type: application/json
```

In bash, construct the header as:
```bash
-H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)"
```

If either env var is missing, tell the user before making any request.

Base URL: `https://eaflood.atlassian.net`

## Steps by command

### Fetch issue (default — just an issue key given)

```bash
curl -s \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  -H "Content-Type: application/json" \
  "https://eaflood.atlassian.net/rest/api/3/issue/PAE-XXXX"
```

Parse and present to the user:
- **Summary**, **Status**, **Assignee**, **Reporter**
- **Description** (render plain text from Atlassian Document Format if present)
- **Priority**, **Story points** (if set)
- **Labels**, **Components**
- **Acceptance criteria** (look for a field named `acceptance_criteria` or a section in the description)
- **Comments** (up to 5 most recent, with author and date)
- **Links** to related issues

### Add comment

```bash
curl -s -X POST \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  -H "Content-Type: application/json" \
  "https://eaflood.atlassian.net/rest/api/3/issue/PAE-XXXX/comment" \
  -d '{
    "body": {
      "type": "doc",
      "version": 1,
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "COMMENT_TEXT" }]
        }
      ]
    }
  }'
```

Confirm success or show error.

### Transition issue status

First, fetch available transitions:

```bash
curl -s \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  "https://eaflood.atlassian.net/rest/api/3/issue/PAE-XXXX/transitions"
```

Find the transition whose `name` matches (case-insensitive) the requested status, then:

```bash
curl -s -X POST \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  -H "Content-Type: application/json" \
  "https://eaflood.atlassian.net/rest/api/3/issue/PAE-XXXX/transitions" \
  -d '{"transition": {"id": "TRANSITION_ID"}}'
```

If no matching transition is found, list the available transitions and ask the user to choose.

### Search issues (JQL)

```bash
curl -s \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  -H "Content-Type: application/json" \
  "https://eaflood.atlassian.net/rest/api/3/search?jql=JQL_QUERY&maxResults=20&fields=summary,status,assignee,priority"
```

Present results as a table: **Key | Summary | Status | Assignee**.

### Update a field

```bash
curl -s -X PUT \
  -H "Authorization: Basic $(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64 -w0)" \
  -H "Content-Type: application/json" \
  "https://eaflood.atlassian.net/rest/api/3/issue/PAE-XXXX" \
  -d '{"fields": {"FIELD_NAME": VALUE}}'
```

## Error handling

- **401 Unauthorized** — `JIRA_TOKEN` is missing or invalid. Tell the user.
- **403 Forbidden** — token lacks permission for that action. Tell the user.
- **404 Not Found** — issue key does not exist. Check for typos.
- **curl error** — no network or bad URL. Show the raw error.

Always show the HTTP status code on failure.

## Notes

- Issue keys are case-insensitive; normalise to uppercase before use.
- Atlassian Document Format (ADF) descriptions are JSON; extract `text` nodes to render readable output.
- Never print the raw `JIRA_TOKEN` value in any output.
