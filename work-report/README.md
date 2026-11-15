# Work Report

A Claude Code mod that shows what Claude has done for you: how many tasks it finished, an estimate of the hours that saved you, and what that time is worth. The pane has four tabs: Today, Week (last 7 days), Month (last 30 days) and Year (January 1 through today).

## Commands

- `/report`: open the pane. `/report week`, `/report month` and `/report year` open it on that tab.
- `/report settings`: list the estimate settings.
- `/report settings rate 75`: set the hourly rate in dollars.
- `/report settings emails 15`: set the minutes saved per task for one kind (emails, documents, images, research, other).

A **Work report** button in the footer, beside the mode labels, opens the pane too.

## What counts

One task is one prompt you typed that ended with an answer. Helper agents, tool steps, cancelled turns and slash commands are not counted. Each task is sorted into one kind by the tools it used:

- **Emails**: any mail tool
- **Images and video**: image or video tools, or writing image and video files
- **Documents**: document, slide or spreadsheet tools, or writing a document file
- **Research**: web search, page reading, transcripts
- **Other**: everything else

## The estimate

Minutes saved per task by default: Emails 10, Documents 30, Images and video 20, Research 25, Other 10, at $50 an hour. Hours and dollars are always shown as estimates.

## Data

One small record per calendar day is kept in the mod's own store: the count of each kind and the count per model. No prompt text or file names are kept. Records older than two years are removed.
