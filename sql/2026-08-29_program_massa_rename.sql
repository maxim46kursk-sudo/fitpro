-- Переименование группы «Масса» → «Набор мышечной массы».
--
-- Меняется ТОЛЬКО display_name: ключи massa-novichok / massa-sredniy и
-- group_key='massa' остаются как есть. За ключи держатся profiles.program и
-- названия тренировок в workouts («{key} — тренировка N»), переименование их
-- не касается — на экран идёт display_name.
--
-- Обе строки, а не одна: заголовок карточки группы берётся от первого
-- варианта, но заголовок открытой программы — от самого варианта, иначе на
-- «среднем уровне» осталась бы прежняя «Масса».
update program_templates
   set display_name = 'Набор мышечной массы', updated_at = now()
 where group_key = 'massa';

-- Проверка: у обоих уровней новое имя, ключи прежние.
-- select key, display_name, subtitle, group_key from program_templates
--  where group_key = 'massa' order by sort;
