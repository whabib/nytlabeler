# NY Times Bluesky Labeler — Development Rules

This document outlines the strict architectural, developmental, and git workflow rules for the NY Times Bluesky Labeler Service. All developers (including AI coding assistants) must strictly adhere to these practices.

---

## 🚀 1. Git Workflow Constraint

*   **No Direct Commits to `main`**: Never commit code changes directly to the `main` branch unless explicitly authorized by the user.
*   **Branch-First Policy**: Always create, implement, and push changes on a dedicated feature/bugfix branch (e.g., `fix/us-display-tests`). Submit a Pull Request on GitHub for verification and merge.

---

## 🧪 2. Automated Test Coverage Requirement

*   **Always Add Test Cases**: Never submit code changes without accompanying automated unit or integration tests.
*   **Special Focus on Display-Oriented Changes**: Any changes to string formatting, localization, casing, or UI representation (such as standardizing `"us"` to `"US"`) must be covered by unit tests verifying those specific formatting functions.

---

## 🔌 3. Environment & Database Awareness

*   **Scoping & Sandboxing**: The PostgreSQL database (`nytdata`) is shared across development and production. All database tables, schema operations, and settings keys (such as `_Settings`) must be strictly partitioned and aware of the current active environment (`dev` or `prod`).
*   **Sequence Robustness**: Ensure that the database sequence synchronization logic (`ensureDatabaseSequence`) and local SQLite state rehydration are fully robust under concurrent container startups.

---

## 🏷️ 4. Label Protocol Constraints & Sequence Ordering

*   **Strict Sequence Order**: Labels must be generated and applied to the Bluesky posts in a strict sequence:
    1.  **Section** (e.g., `"travel"`)
    2.  **Subsection**, if one exists (e.g., `"media"`)
    3.  **Author**, if they are a matching active opinion writer (e.g., `"ross-douthat"`)
*   **Protocol Compliance (Lowercase slugs)**: Underlying cryptographic ATProto label values (`identifier` / `slug`) must remain strictly lowercase kebab-case (e.g., `"us"` or `"opinions"`). User-facing display casing (such as `"US Section"`) should be handled strictly in localized label definitions and frontend displays.
