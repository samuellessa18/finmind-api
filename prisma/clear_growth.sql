DELETE FROM GrowthAction;
DELETE FROM Event WHERE type IN ('growth_active_triggered', 'growth_shadow_triggered', 'growth_displayed', 'growth_clicked');
