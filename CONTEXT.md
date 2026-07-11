# Coredot Editor

Coredot Editor supports workspace-owned professional documents, AI-assisted changes, and project-specific editing behavior. This glossary fixes the domain language used across routes, persistence, UI, and extension modules.

## Identity And Ownership

**Principal**:
An authenticated Clerk user acting on a request.
_Avoid_: Account, actor, current user

**Workspace**:
The ownership scope for documents, templates, AI policy, conversations, and project profiles. A Workspace is backed by either a Clerk organization or a Principal's personal scope.
_Avoid_: Tenant, organization, account

**Workspace Role**:
The Principal's authorization level inside a Workspace: owner, admin, or member.
_Avoid_: User type, permission group

## Documents And Changes

**Document Draft**:
The current editable document title, structured content, metadata, readiness, and revision.
_Avoid_: Document state, editor value

**Document Revision**:
A monotonically increasing version of a persisted Document Draft used to detect conflicting changes.
_Avoid_: Timestamp, content signature, version token

**Document Change**:
A persisted AI-assisted change that records the before state, after revision, proposal relationship, and undo status.
_Avoid_: Local change, history item, patch

**Proposal**:
An AI-generated candidate replacement or insertion that remains pending until it is accepted or rejected.
_Avoid_: Suggestion, finding, edit

## AI Work

**AI Run**:
One recorded execution of an AI command, including its Workspace, input summary, provider, status, and outcome.
_Avoid_: Job, request, generation

**Conversation**:
A Workspace-owned, Document-scoped sequence of user and assistant messages linked to AI Runs and Proposals.
_Avoid_: Chat session, local session, thread

## Project Adaptation

**Project Profile**:
A static product definition that supplies metadata fields, readiness states, filters, and default templates for a downstream editor project.
_Avoid_: Configuration object, preset, schema pack

**Editor Plugin**:
A build-time extension that contributes rendered editor behavior through a supported host interface.
_Avoid_: Add-on, integration, extension point

**Document Interchange**:
Import or export between the Document Draft format and an external document format together with an explicit fidelity report.
_Avoid_: Conversion, file handling, roundtrip
