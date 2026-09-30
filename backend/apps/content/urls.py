from django.urls import path

from . import views

app_name = "content"

urlpatterns = [
    path("announcements/", views.my_announcements, name="announcements"),
    path("announcements/<int:announcement_id>/dismiss/", views.dismiss_announcement, name="announcement-dismiss"),
    path("help/", views.help_centre, name="help"),
]
