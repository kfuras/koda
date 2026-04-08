# USER.md — Who The Operator Is

> This file defines WHO the human behind the agent is. It's loaded into every
> session so the agent can tailor its help to the operator's role, projects,
> voice, and audience.
>
> The more honest and specific you are here, the better the agent can help.
> You're teaching it about a person, not building a dossier for HR.
>
> Fill in each section. Delete the italics explanations once you're done.

## Identity

*Basic facts about you. Name, location, day job, what you do on the side,
your social handles. Keep it short — 8-12 lines.*

- **Name:** <your name>
- **Location:** <your country or region>
- **Day job:** <your role, if relevant to the content you produce>
- **Side projects:** <how much time you spend on what this agent helps with>
- **X:** <@yourhandle> (optional)
- **Bluesky:** <yourhandle.bsky.social> (optional)
- **YouTube:** <@yourchannel> (optional)
- **Website:** <yourdomain.com> (optional)

## Projects (by priority)

*List the projects/products you want the agent to help with. Order matters —
the agent will prioritize the first one when resources are constrained.
For each, include: URL, what it is, current status, and any key context.*

### 1. <Primary project name>
- **URL:** <link>
- **What:** <one-sentence description>
- **Status:** <current state — launched, in progress, needs marketing, etc.>
- **Key context:** <anything the agent should know to help with this>

### 2. <Secondary project name>
- **URL:** <link>
- **What:** <description>
- **Status:** <current state>

### 3. <Third project (if any)>
- *(same structure)*

## Daily Tools

*What software/services you actually use. The agent will reach for these
first when building things. Group them by category.*

- **AI/Agents:** <e.g. Claude Code, Claude API, MCP servers, Agent SDK>
- **Automation:** <e.g. Airtable, Playwright, n8n, Zapier>
- **Publishing:** <e.g. WordPress, Notion, Ghost, Medium>
- **Social:** <e.g. X, Bluesky, LinkedIn, Threads>
- **Video:** <e.g. Remotion, Premiere, DaVinci Resolve>
- **Infrastructure:** <e.g. Docker, Hetzner, AWS, Vercel>
- **Day job:** <tools you use at work, if relevant>
- **Communication:** <e.g. Discord, Slack, email>

## Wants Help With

*What you actually want the agent to do for you. Be specific — "marketing"
is too vague, "drafting 3 X posts per week in my voice based on what I
shipped that week" is useful.*

- *(specific task 1)*
- *(specific task 2)*
- *(specific task 3)*
- *(etc.)*

## Voice & Writing Style

*How you actually write. This is the most important section for content
tasks — without it, the agent will write in generic AI voice. Be specific.*

### Identity
- *How do you refer to yourself in your writing? First person? "We"?
  Never about yourself?*
- *What are you credible about? What do you have evidence of?*

### Sentence Structure
- *Short or long sentences? Fragments okay? Specific openers or closers?*
- *Example openers: "I built...", "I just shipped...", "Here's how..."*

### Rhetorical Devices
- *What patterns do you use? Negation lists? Contrasts? Arrow notation?
  Specific numbers? List a few signature moves.*

### Vocabulary
- **Use:** *words you actually use — e.g., built, shipped, launched, runs,
  automated, handles*
- **Never:** *words you hate — e.g., revolutionary, game-changing,
  10x, leverage, synergy, empower, seamless, robust, "in today's
  fast-paced world"*
- *Tech terms you use freely without defining them*

### Tone
- *Confidence level, warmth level*
- *Emoji usage — how many, when, which ones*
- *Hashtag policy — yes or no*
- *Signature signoffs or anti-signoffs (e.g., "no 'let me know what you
  think'")*

### Platform Variants

*How your voice changes by platform. If you post to multiple places with
different tones, document each.*

- **X/Bluesky:** *character limit, structure, hashtag policy*
- **Blog:** *length, code-heavy or not, standard section structure*
- **Discord:** *formal or casual, length*
- *(add platforms you use)*

### Anti-patterns (things AI gets wrong)

*What does the agent consistently mess up when writing in your voice?
Document each one so it corrects itself.*

- *Too many emojis (you use 0-2)*
- *Adding hashtags (you never use them)*
- *Fluffy intros ("In today's fast-paced world...")*
- *Passive voice ("was built" → "I built")*
- *Generic praise ("this powerful tool" → specific metrics)*
- *(add your own as you notice them)*

## Audience

*Who reads what you publish? Be specific — the agent uses this to decide
tone, depth, and which topics to lean into.*

- **Primary:** *<who you're trying to reach — demographics, pain points,
  what they care about>*
- **Secondary:** *<who else reads your stuff>*
- **Legacy:** *<audience from past work you're de-emphasizing>*

## Context (evolving)

*Running list of facts about how you think, what you've learned recently,
strategic shifts. This section changes over time as the agent learns you.*

- *How you think about problems*
- *Your strategic positioning*
- *Current constraints or tradeoffs you're making*
- *Recent shifts in what you're focused on*
- *(add entries as they become true)*
