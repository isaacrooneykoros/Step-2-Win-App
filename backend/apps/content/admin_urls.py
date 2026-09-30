from django.urls import path

from . import admin_views as v

app_name = "content_admin"

# ROLE: content
urlpatterns = [
    path("announcements/", v.announcements, name="announcements"),
    path("announcements/<int:announcement_id>/", v.announcement_detail, name="announcement-detail"),
    path("announcements/<int:announcement_id>/publish/", v.announcement_publish, name="announcement-publish"),
    path("announcements/<int:announcement_id>/archive/", v.announcement_archive, name="announcement-archive"),
    path("announcements/<int:announcement_id>/duplicate/", v.announcement_duplicate, name="announcement-duplicate"),
    path("help/categories/", v.help_categories, name="help-categories"),
    path("help/categories/reorder/", v.help_categories_reorder, name="help-categories-reorder"),
    path("help/categories/<int:category_id>/", v.help_category_detail, name="help-category-detail"),
    path("help/articles/", v.help_articles, name="help-articles"),
    path("help/articles/reorder/", v.help_articles_reorder, name="help-articles-reorder"),
    path("help/articles/<int:article_id>/", v.help_article_detail, name="help-article-detail"),
]
