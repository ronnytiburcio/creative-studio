ALTER TABLE `assets` ADD `generated` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `assets_generated_idx` ON `assets` (`generated`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `result` text;