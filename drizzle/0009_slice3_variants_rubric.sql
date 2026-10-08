ALTER TABLE `hooks` ADD `variant_mechanic` text;--> statement-breakpoint
ALTER TABLE `hooks` ADD `variant_job_id` integer;--> statement-breakpoint
ALTER TABLE `rubric_versions` ADD `rescore_at` integer;--> statement-breakpoint
-- Versions saved before slice 3 were scored in full: their rescore is approved (only later versions wait for the owner's Rescore click).
UPDATE `rubric_versions` SET `rescore_at` = `created_at` WHERE `rescore_at` IS NULL;