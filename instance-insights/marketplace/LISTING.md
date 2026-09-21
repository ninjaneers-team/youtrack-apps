# Listing

## Name

Instance Insights

## Description

Scores your YouTrack instance out of 100, from twenty-two read-only checks across
its configuration and its process: licences nobody uses, projects without an
owner, custom fields that mean the same thing under three different names, open
work nobody has touched in months.

- The score breaks down per category and per finding, with the arithmetic beside it,
  so every number in the report can be recomputed by hand.
- Every finding states what was measured, why it is worth attention, and when it is
  perfectly fine to leave as it is.
- Mark a finding as intentional, or a single project, board, field or list of values
  within it. The score moves with the decision, the decision holds instance-wide, and
  every report states how much of the score rests on decisions rather than on
  measurements.
- A trend over the last 24 scans in the report, naming what improved, what got worse
  and what is new - and the current score on a dashboard tile.
- Two exports: a printable document to hand on outside the instance, and Markdown to
  paste into the issue that tracks the cleanup.

It reads, it never writes. Report and dashboard tile open only for accounts holding
Low-level Admin Write, YouTrack's permission for administering the instance itself.
A scan runs in the browser of the administrator who starts it, with that
administrator's own permissions - no service account, no stored token, no background
job. What it keeps between visits stays in the instance's own database, and no
account is named in it.

Needs YouTrack 2024.3 or newer. On versions before 2026.2 the dashboard tile needs
the classic interface. MIT licensed.

## Tags

Administration, Reporting, Dashboard

## Screenshots

1. `screenshots/01-report-top.png` - the score, its bar, the trend, and where the
   points went
2. `screenshots/02-finding-reasoning.png` - one finding with its reasoning and the
   arithmetic under it
3. `screenshots/03-mark-objects.png` - an object table with a decision already in it
4. `screenshots/04-dashboard-tile.png` - the score tile on a dashboard
5. `screenshots/05-export-menu.png` - both exports, with what each one is for
6. `screenshots/06-report-light.png` - the same page on the light theme
