CREATE TABLE `article_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`confidence` real DEFAULT 1,
	`context` text,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`url_hash` text NOT NULL,
	`title` text,
	`content` text,
	`published_at` integer,
	`scraped_at` integer NOT NULL,
	`source` text NOT NULL,
	`sector` text,
	`language` text,
	`risk_score` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_url_unique` ON `articles` (`url`);--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_message_at` integer
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`sector` text,
	`country` text,
	`first_seen_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_extraction_items` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`extraction_item_id` text NOT NULL,
	`value_json` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extraction_item_id`) REFERENCES `extraction_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`description` text,
	`event_type` text,
	`occurred_at` integer,
	`metrics_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `extraction_items` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`category` text,
	`prompt` text NOT NULL,
	`output_schema` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extraction_items_label_unique` ON `extraction_items` (`label`);--> statement-breakpoint
CREATE TABLE `fiscal_calendars` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_name` text NOT NULL,
	`year_start_month` integer DEFAULT 1 NOT NULL,
	`quarter_start_months` text DEFAULT '[1,4,7,10]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fiscal_calendars_entity_name_unique` ON `fiscal_calendars` (`entity_name`);--> statement-breakpoint
CREATE TABLE `pipeline_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`query` text,
	`progress` text,
	`items_total` integer DEFAULT 0,
	`items_completed` integer DEFAULT 0,
	`started_at` integer,
	`completed_at` integer,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` text PRIMARY KEY NOT NULL,
	`from_entity_id` text NOT NULL,
	`to_entity_id` text NOT NULL,
	`relationship_type` text NOT NULL,
	`weight` real DEFAULT 1,
	`article_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`from_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `risk_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`entity_id` text,
	`risk_type` text NOT NULL,
	`category` text,
	`severity` text,
	`direction` text,
	`rationale` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sectors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`keywords` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sectors_name_unique` ON `sectors` (`name`);