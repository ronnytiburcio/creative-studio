DROP INDEX `assets_section_idx`;--> statement-breakpoint
ALTER TABLE `assets` ADD `ignored` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `assets_section_idx` ON `assets` (`section_id`,`missing`,`ignored`);