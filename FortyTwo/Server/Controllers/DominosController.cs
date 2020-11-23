using System.Collections.Generic;
using FortyTwo.Shared.Extensions;
using FortyTwo.Shared.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace FortyTwo.Server.Controllers
{
    [Route("api/[controller]")]
    [ApiController]
    public class DominosController : ControllerBase
    {
        private readonly ILogger<DominosController> logger;

        public DominosController(ILogger<DominosController> logger)
        {
            this.logger = logger;
        }

        [HttpGet]
        public IEnumerable<Domino> Get()
        {
            var dominos = new List<Domino>();
            for (var i = 0; i < 7; ++i)
            {
                for (var j = i; j < 7; ++j)
                {
                    dominos.Add(new Domino(i, j));
                }
            }

            dominos.Shuffle();

            // TODO: add in some trickery so that the dominos aren't always the same direction
            // - 5|1 is always in this orientation currently

            return dominos;
        }
    }
}
