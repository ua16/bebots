# Grok Bot — Feature Summary

I have marked what is important to replicate in our app and what is not.

## 1. Persistent, Named Bots (WANT)

- Create multiple specialized bots with unique names, roles, and instructions.
- Maintain bot-specific context, preferences, and conversation history.
- Assign different responsibilities to different bots.

## 2. Persistent Cloud Computer (DON'T WANT)

- Provide bots with a persistent cloud environment.
- Access a browser, filesystem, and terminal.
- Continue executing tasks when the user's local computer is offline.
- Allow users to inspect the environment and take control when needed.

## 3. Browser and Computer Automation (DON'T WANT, COMPUTER USE NOT A GOAL)

- Navigate websites and interact with web applications.
- Click buttons, fill forms, read pages, and extract information.
- Use graphical computer interaction when dedicated integrations are unavailable.
- Automate multi-step workflows across supported websites.

## 4. Multi-Bot Collaboration (WANT)

- Run tasks in parallel across multiple bots.
- Allow bots to communicate and share information.
- Delegate subtasks to specialized bots.
- Support task handoffs between bots.
- Enable coordinator bots to organize work across a team.

## 5. Scheduled and Event-Triggered Routines (WANT)

- Execute workflows on a recurring schedule.
- Trigger tasks in response to supported events.
- Automate recurring administrative work.
- Generate periodic reports and notifications.

## 6. Reusable Skills and Workflows (WANT)

- Teach bots how to perform repeatable tasks.
- Save procedures as reusable skills.
- Define workflow inputs, execution steps, and expected outputs.
- Include validation and approval requirements in workflows.
- Reuse skills across subsequent tasks.

## 7. App Integrations and Connectors (WANT, but not MVP, use harness connectors)

- Connect bots to supported external applications and services.
- Use structured integrations where available.
- Fall back to browser automation for applications without dedicated integrations.
- Automate workflows spanning multiple connected services.

## 8. Human Approval and Oversight (WANT)

- Require human approval before executing sensitive actions.
- Review proposed emails, messages, and other changes.
- Restrict actions such as deleting data, making purchases, or modifying production systems.
- Keep users informed about task progress and execution results.

## 9. Persistent Memory and Shared Context (WANT)

- Retain relevant information between tasks.
- Preserve bot instructions, preferences, and working context.
- Reuse files and browser sessions across tasks.
- Share the cloud computer and its sessions between bots belonging to the same account.

## 10. Messaging and Mobile Access (WANT, achieved through API, but not MVP)

- Interact with bots through conversational interfaces.
- Provide new instructions while tasks are running.
- Receive task updates and notifications.
- Respond to approval requests from supported desktop and mobile interfaces.

## Core Product Concept

Grok Bot is designed as a persistent AI workforce rather than a conventional chatbot.

Its main building blocks are:

- **Agents:** Specialized bots with distinct roles and instructions.
- **Execution environments:** Persistent computers where bots perform work.
- **Tools:** Browser automation, terminals, files, and external integrations.
- **Orchestration:** Delegation, parallel execution, and agent-to-agent communication.
- **Skills:** Reusable procedures for repeatable tasks.
- **Scheduling:** Background and event-triggered execution.
- **Human oversight:** Approvals, notifications, and user control.
