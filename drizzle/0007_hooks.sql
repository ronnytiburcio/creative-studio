CREATE TABLE `hook_scores` (
	`hook_id` integer NOT NULL,
	`rubric_version` integer NOT NULL,
	`answers` text NOT NULL,
	`unsure` text NOT NULL,
	`overall` real,
	`pp_person` real,
	`pp_pain` real,
	`pp_promise` real,
	`style` text,
	`avatar` text,
	`stops_scroll` real,
	`notes_fp` text,
	`model` text NOT NULL,
	`call_id` integer,
	`scored_at` integer NOT NULL,
	PRIMARY KEY(`hook_id`, `rubric_version`),
	FOREIGN KEY (`hook_id`) REFERENCES `hooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `hook_scores_version_idx` ON `hook_scores` (`rubric_version`,`overall`);--> statement-breakpoint
CREATE TABLE `hooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`section_id` integer NOT NULL,
	`client_id` integer,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`norm` text NOT NULL,
	`asset_id` integer,
	`source` text NOT NULL,
	`angle_slug` text,
	`parent_id` integer,
	`kept` integer,
	`archived_at` integer,
	`score_requested_at` integer,
	`score_error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `hooks_channel_idx` ON `hooks` (`section_id`,`client_id`,`kind`,`norm`);--> statement-breakpoint
CREATE INDEX `hooks_asset_idx` ON `hooks` (`asset_id`);--> statement-breakpoint
CREATE INDEX `hooks_parent_idx` ON `hooks` (`parent_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`saved_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rubric_versions` (
	`version` integer PRIMARY KEY NOT NULL,
	`dimensions` text NOT NULL,
	`mechanics` text NOT NULL,
	`avatars` text NOT NULL,
	`note` text,
	`current` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_versions_current_uniq` ON `rubric_versions` (`current`) WHERE current = 1;--> statement-breakpoint
ALTER TABLE `clients` ADD `brand_notes_saved_at` integer;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `hooks_state` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `hooks_current` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `hooks_note` text;