ALTER TABLE `rubric_versions` ADD `briefs` text;--> statement-breakpoint
ALTER TABLE `rubric_versions` ADD `section_versions` text;--> statement-breakpoint
-- Landing page Phase 2 slice 1: every existing version keeps its own number for every section (every copy gate key and label stays valid); briefs stay null (= the legacy fixed briefs).
UPDATE `rubric_versions` SET `section_versions` = json_object('rtm', `version`, 'fkbpros', `version`, 'fkb', `version`) WHERE `section_versions` IS NULL;
