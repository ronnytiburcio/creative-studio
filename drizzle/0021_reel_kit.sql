CREATE TABLE `reel_kit_notes` (
	`asset_id` integer PRIMARY KEY NOT NULL,
	`note_name` text NOT NULL,
	`version` integer,
	`test_change` text,
	`test_detail` text,
	`size` integer,
	`mtime` integer,
	`read_at` integer NOT NULL,
	`error` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `shorts` ADD `cold_start_s` real;--> statement-breakpoint
ALTER TABLE `shorts` ADD `cold_end_s` real;--> statement-breakpoint
ALTER TABLE `shorts` ADD `cold_text` text;--> statement-breakpoint
ALTER TABLE `shorts` ADD `cold_hook_id` integer REFERENCES hooks(id);--> statement-breakpoint
ALTER TABLE `shorts` ADD `cold_hook_owned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `shorts` ADD `source_card_id` integer;--> statement-breakpoint
ALTER TABLE `shorts` ADD `handoff_kit_version` integer;--> statement-breakpoint
CREATE INDEX `shorts_cold_hook_idx` ON `shorts` (`cold_hook_id`);