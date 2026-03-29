CREATE TABLE `entity_affiliations` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`related_entity_id` text NOT NULL,
	`affiliation_type` text NOT NULL,
	`role` text,
	`ownership_pct` real,
	`start_date` text,
	`end_date` text,
	`is_current` integer DEFAULT true NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`confidence` real DEFAULT 1,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `entity_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`aliases` text,
	`description` text,
	`website` text,
	`notes` text,
	`date_of_birth` text,
	`nationality` text,
	`gender` text,
	`registration_no` text,
	`incorporated_date` text,
	`jurisdiction` text,
	`listed_exchange` text,
	`listed_date` text,
	`researched_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_profiles_entity_id_unique` ON `entity_profiles` (`entity_id`);