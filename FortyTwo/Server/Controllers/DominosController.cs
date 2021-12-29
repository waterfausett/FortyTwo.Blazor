using FortyTwo.Shared.Models;
using FortyTwo.Shared.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using System.Collections.Generic;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class DominosController : ControllerBase
    {
        private readonly ILogger<DominosController> _logger;
        private readonly IDominoService _dominoService;

        public DominosController(ILogger<DominosController> logger, IDominoService dominoService)
        {
            _logger = logger;
            _dominoService = dominoService;
        }

        [AllowAnonymous]
        [HttpGet]
        public IEnumerable<Domino> Get()
        {
            return _dominoService.Build(DominoType.DoubleSix);
        }
    }
}
