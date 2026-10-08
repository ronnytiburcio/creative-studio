CREATE TABLE `ai_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` integer NOT NULL,
	`purpose` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`asset_id` integer,
	`questions` text NOT NULL,
	`state_chars` integer NOT NULL,
	`input_tokens` integer,
	`answers` text,
	`min_confidence` real,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`ms` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `ai_calls_created_idx` ON `ai_calls` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_calls_asset_idx` ON `ai_calls` (`asset_id`);--> statement-breakpoint
CREATE TABLE `ai_corrections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`asset_id` integer NOT NULL,
	`question` text NOT NULL,
	`jev_answer` text,
	`ronny_answer` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_corrections_created_idx` ON `ai_corrections` (`created_at`);--> statement-breakpoint
CREATE TABLE `classifications` (
	`asset_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`version` integer NOT NULL,
	`answers` text NOT NULL,
	`unsure` text NOT NULL,
	`call_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `assets` ADD `class_source` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `energy` real;--> statement-breakpoint
ALTER TABLE `assets` ADD `classified_at` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `classify_version` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD `classify_model` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `classify_error` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `classify_requested_at` integer;--> statement-breakpoint
CREATE INDEX `assets_review_idx` ON `assets` (`needs_review`);--> statement-breakpoint
CREATE INDEX `assets_class_idx` ON `assets` (`asset_class`);--> statement-breakpoint
ALTER TABLE `clients` ADD `classify_hint` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `classify_state` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `classify_current` text;--> statement-breakpoint
ALTER TABLE `worker_status` ADD `classify_note` text;