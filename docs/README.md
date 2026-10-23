# Documentation Index

Welcome to the Opal Line Billing ERP documentation set. This directory contains eight reference documents covering the project's architecture, coding standards, design system, product requirements, security, and testing.

## Documentation Overview

| File | Description | Recommended Reading |
|---|---|---|
| **AGENTS.md** | Project-specific instructions for AI coding agents. Repository structure, coding rules, commands, architecture rules, safe editing practices, database migration rules, security requirements, and rules agents must follow before modifying existing features. | Read first for agent-specific conventions and safety rails |
| **ARCHITECTURE.md** | Project overview and technology stack. High-level architecture with Mermaid diagrams, frontend/backend architecture, folder structure, request lifecycle from frontend to backend to database, API endpoints with authentication and responses, database entities and relationships, third-party integrations, state management and data flow, error handling and logging, build and deployment architecture, and existing architectural weaknesses with recommended improvements. | Read after AGENTS.md for system-wide understanding |
| **CODE_STYLE.md** | Language-specific coding conventions, file and folder naming, component/function/class/variable naming, TypeScript/JavaScript conventions, import organization, component and service structure, API response and error-handling conventions, validation and database-access patterns, formatting, linting, and code-quality tools. Includes real examples from the codebase and identified inconsistencies. | Read in parallel with ARCHITECTURE.md when diving into code |
| **DESIGN_SYSTEM.md** | UI framework and styling technology. Color palette, typography, spacing, sizing, and breakpoints from the actual `theme.css`. Buttons, inputs, cards, modals, tables, navigation, and other reusable UI elements. Layout patterns and responsive behavior. Component variants and interaction states. Accessibility standards. Design tokens and CSS variables. Existing UI inconsistencies and recommendations. | Read after ARCHITECTURE.md for UI details |
| **PRD.md** | Product Requirements Document. Product overview and purpose, problems solved, target users and roles, core features and business workflows, functional requirements with unique IDs, non-functional requirements, user stories and acceptance criteria, key business rules and validations, integration requirements, constraints and dependencies, known limitations, and future improvements. Distinguishes verified existing functionality from proposed functionality. | Read for product context and feature verification |
| **README.md** (this file) | Documentation index for the `docs/` folder. Project documentation overview, links to all seven other Markdown files, a short description of each document, recommended reading order, and instructions for keeping documentation updated. | Read as entry point |
| **SECURITY.md** | Security-focused review. Authentication and authorization mechanisms, password storage and hashing practices, session/JWT/cookie/token security, input validation and output encoding, SQL injection and other injection risks, XSS/CSRF/CORS/SSRF/rate limiting, secrets and environment-variable management, file uploads and access controls, dependency vulnerabilities and security configuration, sensitive data exposure and logging risks, database and API security, production deployment security, findings with severity/affected files/evidence/impact/remediation, and prioritized security recommendations. | Read for security model and threat model |
| **TESTING.md** | Testing documentation. Existing testing frameworks and tools (unit, integration, API, end-to-end, UI). Current test directory structure. How to install dependencies and run tests. Build, lint, type-check, and validation commands. Database setup and test environment requirements. Existing test coverage and missing test scenarios. Critical business workflows requiring testing. Authentication and authorization test cases. Error handling and edge-case testing. Security testing recommendations. CI/CD testing requirements. Prioritized testing roadmap. | Read for testing strategies and commands |

## Reading Order (Recommended)

1. **README.md** (this file) — Entry point and overview
2. **AGENTS.md** — Agent-specific rules and safety rails
3. **ARCHITECTURE.md** — System architecture, diagrams, request lifecycle
4. **PRD.md** — Product requirements and feature verification
5. **SECURITY.md** — Security model and recommendations
6. **CODE_STYLE.md** — Coding conventions and style rules
7. **DESIGN_SYSTEM.md** — UI/UX design tokens and components
8. **TESTING.md** — Testing strategies, commands, and roadmap

## Keeping Documentation Updated

- **AGENTS.md**: Update if coding rules, migration rules, or security requirements change
- **ARCHITECTURE.md**: Update if major architectural changes are made (new modules, framework migrations, request flow changes)
- **CODE_STYLE.md**: Update if linting rules, import conventions, or naming patterns change
- **DESIGN_SYSTEM.md**: Update if color palette, typography, component variants, or breakpoints change
- **PRD.md**: Update functional requirements if FRs are added/removed; update "implemented" status when features ship
- **SECURITY.md**: Update after security reviews; add new findings; remediate and remove resolved items
- **TESTING.md**: Update when new test files are added; when test commands change; when coverage gaps are addressed
- **Never modify the root `README.md`** (the project's marketing/README at the repo root). This `docs/README.md` is purely an index for the documentation folder.

## Internal Linking

All internal links use relative paths that work within the `docs/` directory. For example:

- `[AGENTS.md](AGENTS.md)` links to `docs/AGENTS.md`
- `[ARCHITECTURE.md](ARCHITECTURE.md)` links to `docs/ARCHITECTURE.md`
- And so on for all seven other files

Links to the root project's README should reference `../README.md` if needed, but this documentation index is separate from the root README.

---
*Generated from the Opal Line Billing ERP codebase. For the project's root README (marketing overview, installer instructions, license), see the repository root `README.md`.*