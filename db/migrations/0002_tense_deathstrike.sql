CREATE TABLE `supervisor_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`summary` text,
	`key_findings_json` text,
	`recommendations_json` text,
	`confidence` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supervisor_briefs_run_id_unique` ON `supervisor_briefs` (`run_id`);--> statement-breakpoint
CREATE TABLE `supervisor_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`article_id` text,
	`entity_id` text,
	`event_id` text,
	`finding_type` text NOT NULL,
	`claim` text NOT NULL,
	`evidence_quote` text,
	`source_url` text,
	`confidence` real,
	`severity` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `supervisor_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`decision` text NOT NULL,
	`reviewer` text,
	`notes` text,
	`reviewed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supervisor_reviews_run_id_unique` ON `supervisor_reviews` (`run_id`);--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD `supervisor_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD `source_domain` text;--> statement-breakpoint
ALTER TABLE `pipeline_runs` ADD `research_goal` text;