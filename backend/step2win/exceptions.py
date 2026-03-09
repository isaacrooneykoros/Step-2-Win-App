from rest_framework.views import exception_handler


def custom_exception_handler(exc, context):
    """
    Custom exception handler for DRF
    """
    # Call REST framework's default exception handler first
    response = exception_handler(exc, context)

    # Add custom error formatting
    if response is not None:
        custom_response_data = {
            'error': True,
            'message': str(exc),
            'details': response.data
        }
        response.data = custom_response_data

    return response
