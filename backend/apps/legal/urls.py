from django.urls import path
from . import views

urlpatterns = [
    # ── Public (mobile app) ───────────────────────────────────────────────
    path('',                                  views.list_documents_public),
    path('<slug:slug>/',                      views.get_document_public),
    path('<slug:slug>/acknowledge/',          views.acknowledge_document),

    # ── Admin panel ───────────────────────────────────────────────────────
    path('admin/documents/',                  views.list_documents_admin),
    path('admin/documents/create/',           views.create_document_admin),
    path('admin/documents/<int:pk>/',         views.document_detail_admin),
    path('admin/documents/<int:pk>/publish/', views.publish_document),
    path('admin/documents/<int:pk>/history/', views.document_history),
    path('admin/documents/<int:pk>/restore/<int:version_id>/',
                                              views.restore_version),
]
